// Central Hub — end-to-end check of the AI run lifecycle against a real
// PostgREST and a real Postgres.
//
// This reproduces the bug that produced:
//   invalid input syntax for type uuid: "[object Object]"
// by running the EXACT functions that failed (insertAiRun -> completeAiRun)
// against a real database with a real signed JWT, and by showing that the old
// shape (passing the row where an id belongs) still fails the way it did.
//
// It is run by the harness in /tmp, which starts the containers and passes the
// configuration in through the environment.

import { createServer, request as forward } from "node:http";
import assert from "node:assert/strict";

const JWT = process.env.VITE_SUPABASE_ANON_KEY;
const USER_ID = process.env.TEST_USER_ID;
const POSTGREST_ORIGIN = process.env.POSTGREST_ORIGIN;

assert(JWT && USER_ID && POSTGREST_ORIGIN, "the harness must supply the jwt, the user id and the postgrest origin");

/**
 * A stand-in for Supabase's gateway.
 *
 * The Supabase client appends `/rest/v1` to the project URL, because that is
 * where the gateway serves PostgREST from. A bare PostgREST serves at `/`, so
 * the harness needs something in between that strips the prefix — otherwise
 * every request 404s and the test would be measuring the harness, not the app.
 */
const gateway = createServer((request, response) => {
  const path = request.url.replace(/^\/rest\/v1/, "") || "/";
  const target = new URL(path, POSTGREST_ORIGIN);

  const proxied = forward(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: request.method,
      headers: request.headers,
    },
    (upstream) => {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
    }
  );

  request.pipe(proxied);
});

await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));

// The client reads its configuration from the environment when the module is
// first imported, so it is set before anything is imported.
process.env.VITE_SUPABASE_URL = `http://127.0.0.1:${gateway.address().port}`;
process.env.VITE_SUPABASE_ANON_KEY = JWT;

const { insertAiRun, completeAiRun, listAiRuns, assertUuidId } = await import(
  "../src/lib/ai.js"
);
const { supabase } = await import("../src/lib/supabase.js");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  }
}

console.log("Central Hub — AI run lifecycle against real PostgREST\n");

// The session must be the real signed-in user.
//
// The harness runs PostgREST without a GoTrue server, so `auth.getUser()` is
// not available. The session is verified the way that actually matters here:
// the caller's own rows must be visible, and nobody else's.
const { data: own, error: ownError } = await supabase
  .from("ai_runs")
  .select("id, user_id");

assert(!ownError, `the session must be valid: ${ownError?.message}`);
assert(
  (own ?? []).every((row) => row.user_id === USER_ID),
  "only the caller's own rows may be visible"
);

await check("a run is created and its id is a uuid string", async () => {
  const runId = await insertAiRun({
    kind: "priorities",
    provider: "local",
    model: "on-device-rules",
    inputDigest: "deadbeef",
    input: { totals: { logEntries: 1 } },
  });

  assert.equal(typeof runId, "string", "insertAiRun must return a string");
  assert.match(
    runId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    `the id must be a uuid, got ${JSON.stringify(runId)}`
  );
});

await check("the run can be completed — the query that failed before", async () => {
  const runId = await insertAiRun({
    kind: "day_summary",
    provider: "local",
    model: "on-device-rules",
    inputDigest: "cafe",
    input: null,
  });

  // This is the exact call that produced the uuid syntax error: the id was a
  // row object, so PostgREST put "[object Object]" in the query.
  const row = await completeAiRun(runId, {
    status: "success",
    output: { summary: "1 work log entry was recorded.", highlights: [] },
  });

  assert.equal(row.status, "success", "the run must be closed as a success");
  assert.equal(row.id, runId, "the closed run must be the one that was opened");
  assert.ok(row.completed_at, "the run must carry the moment it completed");
});

await check("the completed run is readable by its owner", async () => {
  const { rows, total } = await listAiRuns({ limit: 10 });
  assert(total >= 2, `at least two runs must exist, got ${total}`);
  const success = rows.find((row) => row.status === "success");
  assert(success, "a successful run must be listed");
  assert.equal(success.output.summary, "1 work log entry was recorded.", "the answer is stored");
});

await check("the OLD shape still fails exactly as it did", async () => {
  // The bug, reproduced deliberately: the whole row is passed where the id
  // belongs. The database answers with the uuid syntax error, which is exactly
  // what the user saw.
  const { data: row, error: insertError } = await supabase
    .from("ai_runs")
    .insert({
      kind: "priorities",
      provider: "local",
      model: "on-device-rules",
      input_digest: "beef",
      status: "running",
    })
    .select("id, kind")
    .single();

  assert(!insertError, `the insert must succeed: ${insertError?.message}`);

  const { error } = await supabase
    .from("ai_runs")
    .update({ status: "success" })
    .eq("id", row);

  assert(error, "passing the row must fail");
  assert.match(
    error.message,
    /invalid input syntax for type uuid/i,
    `expected the uuid syntax error, got: ${error.message}`
  );
  assert.match(
    error.message,
    /\[object Object\]/,
    `expected the row to be stringified into the query, got: ${error.message}`
  );
});

await check("the id check refuses a row before the database sees it", async () => {
  assert.throws(
    () => assertUuidId({ id: "x" }, "The id of the AI run to complete"),
    /must be a uuid string, not an object/,
    "the guard must refuse a row"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
gateway.close();
if (failed > 0) process.exit(1);
