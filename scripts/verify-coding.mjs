// Central Hub — coding tracker assertions.
//
// Run:  node scripts/verify-coding.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deterministicUuid as appUuid } from "../src/lib/stableId.js";
import { deterministicUuid as extensionUuid } from "../extensions/coding-tracker/lib/stableId.js";
import {
  ACTIVITY_KIND,
  EDITORS,
  coveredSeconds,
  detectEditor,
  editorLabel,
  fileLabel,
  foldHeartbeats,
  groupedCoveredSeconds,
  heartbeatsFromRows,
  initialTrackerState,
  languageLabel,
  projectLabel,
  reduceTracker,
  scopeHeartbeatId,
} from "../extensions/coding-tracker/lib/codingTime.js";
import { acknowledgeHeartbeats, enqueueHeartbeats, nextBackoffSeconds } from "../extensions/coding-tracker/lib/queue.js";
import {
  buildInsertHeartbeatsRequest,
  buildSignInRequest,
  buildUpsertIntegrationRequest,
  toObservationRow,
} from "../extensions/coding-tracker/lib/transport.js";
import { codingTrackerAdapter } from "../src/features/integrations/adapters/codingTracker.js";
import { getAdapter } from "../src/features/integrations/contract.js";
import { localDayRange, reportRangeBounds } from "../src/features/coding/range.js";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`threw ${JSON.stringify(error.message)}, expected ${pattern}`);
    }
    return;
  }
  throw new Error("expected a throw");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function activity(at, extra = {}) {
  return {
    type: "activity",
    at,
    editor: "vscode",
    projectName: "hub",
    fileName: "App.jsx",
    language: "javascript",
    ...extra,
  };
}

function run(events, options) {
  let state = initialTrackerState({ editor: "vscode" });
  const heartbeats = [];
  for (const event of events) {
    const result = reduceTracker(state, event, options);
    state = result.state;
    heartbeats.push(...result.heartbeats);
  }
  return { state, heartbeats };
}

console.log("Central Hub — coding tracker assertions\n");

console.log("Editor and labels");
check("Cursor is detected and every other host is VS Code", () => {
  assertEqual(detectEditor("Cursor"), "cursor", "Cursor");
  assertEqual(detectEditor("cursor"), "cursor", "lowercase");
  assertEqual(detectEditor("Visual Studio Code"), "vscode", "VS Code");
  assertEqual(detectEditor("Code - OSS"), "vscode", "Code OSS");
  assertEqual(detectEditor(""), "vscode", "empty app name");
  assertEqual(editorLabel("cursor"), "Cursor", "label");
  assertEqual(editorLabel("vscode"), "VS Code", "label");
});

check("file and project labels keep the name and drop the path", () => {
  assertEqual(fileLabel("/home/me/src/App.jsx"), "App.jsx", "posix");
  assertEqual(projectLabel("C:\\Users\\me\\central-hub"), "central-hub", "windows");
  assertEqual(fileLabel("App.jsx"), "App.jsx", "already a name");
  assertEqual(fileLabel("../secret.txt"), null, "parent segment");
  assertEqual(projectLabel(""), null, "empty");
  assertEqual(languageLabel("javascript"), "javascript", "language");
  assertEqual(languageLabel("a/b"), null, "language path");
});

console.log("\nActive time");
check("a single activity has no measured span", () => {
  const { heartbeats } = run([activity(0), { type: "tick", at: 400 }]);
  assertEqual(heartbeats.length, 0, "nothing stored");
});

check("time is the span between activities, and idle is not counted", () => {
  const { heartbeats } = run([
    activity(0),
    activity(50),
    { type: "tick", at: 50 + 7200 },
  ]);
  assertEqual(heartbeats.length, 1, "one heartbeat");
  assertEqual(heartbeats[0].durationSeconds, 50, "fifty active seconds");
  assertEqual(heartbeats[0].fileName, "App.jsx", "file");
  assertEqual(heartbeats[0].editor, "vscode", "editor");
  assertEqual(heartbeats[0].source, "collector", "source");
  assertEqual(heartbeats[0].activityKind, "coding", "kind");
  assert(heartbeats[0].durationSeconds < 7200, "the idle gap is not active time");
});

check("a full path on an activity is stored as a file name", () => {
  const { heartbeats } = run([
    activity(0, { fileName: "/home/me/src/App.jsx", projectName: "/home/me/central-hub" }),
    activity(30, { fileName: "/home/me/src/App.jsx", projectName: "/home/me/central-hub" }),
    { type: "tick", at: 400 },
  ]);
  assertEqual(heartbeats[0].fileName, "App.jsx", "file");
  assertEqual(heartbeats[0].projectName, "central-hub", "project");
});

check("a parent-segment file name is not stored", () => {
  const { heartbeats } = run([
    activity(0, { fileName: "../secret.txt" }),
    activity(20, { fileName: "../secret.txt" }),
    { type: "tick", at: 400 },
  ]);
  assertEqual(heartbeats[0].fileName, null, "rejected");
});

check("heartbeats split at the heartbeat length and keep the remainder", () => {
  const { heartbeats } = run([activity(0), activity(100), activity(130), { type: "tick", at: 400 }]);
  assertEqual(heartbeats.length, 2, "two slices");
  assertEqual(heartbeats[0].durationSeconds, 120, "full slice");
  assertEqual(heartbeats[1].durationSeconds, 10, "remainder");
  assertEqual(
    heartbeats.reduce((sum, beat) => sum + beat.durationSeconds, 0),
    130,
    "the whole active span"
  );
});

check("switching files attributes the gap to the file that was active", () => {
  const { heartbeats } = run([
    activity(0, { fileName: "A.js" }),
    activity(40, { fileName: "B.js" }),
    { type: "tick", at: 400 },
  ]);
  assertEqual(heartbeats.length, 1, "the new file has no span yet");
  assertEqual(heartbeats[0].fileName, "A.js", "old file");
  assertEqual(heartbeats[0].durationSeconds, 40, "gap");
});

check("pause, blur, and an unfocused window do not count time", () => {
  const paused = run([activity(0), activity(20), { type: "pause", at: 25 }, activity(80), activity(100)]);
  assertEqual(paused.heartbeats.length, 1, "pause flushes the span");
  assertEqual(paused.heartbeats[0].durationSeconds, 20, "only the active span");

  const blurred = run([activity(0), activity(30), { type: "blur", at: 45 }]);
  assertEqual(blurred.heartbeats[0].durationSeconds, 30, "blur does not extend the span");

  const away = run([
    { type: "blur", at: 0 },
    activity(10),
    activity(40),
    { type: "tick", at: 400 },
  ]);
  assertEqual(away.heartbeats.length, 0, "unfocused activity is not counted");
});

check("a pause does not bridge into the next burst", () => {
  const { heartbeats } = run([
    activity(0),
    activity(20),
    { type: "pause", at: 20 },
    { type: "resume", at: 30 },
    activity(500),
    activity(530),
    { type: "tick", at: 800 },
  ]);
  assertEqual(
    heartbeats.reduce((sum, beat) => sum + beat.durationSeconds, 0),
    50,
    "20 before the pause plus 30 after it"
  );
});

console.log("\nSessions and totals");
check("sessions group by project and editor and split on a long gap", () => {
  const beats = [
    beat("2026-10-22T10:00:00.000Z", 120, { editor: "cursor", projectName: "hub", fileName: "A.js" }),
    beat("2026-10-22T10:02:00.000Z", 60, { editor: "cursor", projectName: "hub", fileName: "B.js", language: "javascript" }),
    beat("2026-10-22T11:00:00.000Z", 30, { editor: "cursor", projectName: "hub", fileName: "A.js" }),
    beat("2026-10-22T11:00:00.000Z", 30, { editor: "vscode", projectName: "hub", fileName: "A.js" }),
  ];
  const sessions = foldHeartbeats(beats);
  assertEqual(sessions.length, 3, "gap, then editor");
  assertEqual(sessions[0].durationSeconds, 180, "first two heartbeats");
  assertEqual(sessions[0].files.length, 2, "both files");
  assertEqual(sessions[0].editor, "cursor", "editor");
  assertEqual(sessions[1].projectName, "hub", "same project after the gap");
  assertEqual(sessions[2].editor, "vscode", "other editor");
});

check("overlapping editors are counted once in the total", () => {
  const beats = [
    beat("2026-10-22T10:00:00.000Z", 120, { editor: "cursor", projectName: "hub" }),
    beat("2026-10-22T10:00:00.000Z", 120, { editor: "vscode", projectName: "notes" }),
  ];
  assertEqual(coveredSeconds(beats), 120, "union");
  const projects = groupedCoveredSeconds(beats, (item) => item.projectName);
  const projectSum = projects.reduce((sum, row) => sum + row.activeSeconds, 0);
  assert(projectSum > coveredSeconds(beats), "per-project sums can exceed the union");
});

check("a heartbeat with no duration is missing, not zero", () => {
  const rows = heartbeatsFromRows([
    { occurred_at: "2026-10-22T10:00:00.000Z", duration_seconds: null, editor: "cursor", activity_kind: "coding" },
  ]);
  assertEqual(coveredSeconds(rows), null, "no measured coverage");
  const [session] = foldHeartbeats(rows);
  assertEqual(session.durationSeconds, null, "session duration");
});

check("the same heartbeat id is stable per connection and different across connections", () => {
  const heartbeat = beat("2026-10-22T10:00:00.000Z", 120, { editor: "cursor", projectName: "hub", fileName: "App.jsx" });
  const first = scopeHeartbeatId("connection-a", heartbeat);
  const second = scopeHeartbeatId("connection-a", heartbeat);
  const other = scopeHeartbeatId("connection-b", heartbeat);
  assertEqual(first, second, "stable");
  assert(first !== other, "scoped");
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first), "uuid shape");
});

check("the extension's id function matches the app's", () => {
  assertEqual(appUuid("coding|cursor|hub"), extensionUuid("coding|cursor|hub"), "same id");
});

console.log("\nQueue and transport");
check("the queue dedupes, drops the oldest when full, and acknowledges a sent batch", () => {
  const first = beat("2026-10-22T10:00:00.000Z", 10, { fileName: "A.js" });
  const second = beat("2026-10-22T10:01:00.000Z", 10, { fileName: "B.js" });
  const third = beat("2026-10-22T10:02:00.000Z", 10, { fileName: "C.js" });
  const deduped = enqueueHeartbeats([first], [first, second]);
  assertEqual(deduped.queue.length, 2, "duplicate collapsed");
  assertEqual(deduped.dropped, 0, "nothing dropped");
  const limited = enqueueHeartbeats([first, second], [third], 2);
  assertEqual(limited.dropped, 1, "one dropped");
  assertEqual(limited.queue[0].fileName, "B.js", "oldest dropped");
  assertEqual(limited.queue[1].fileName, "C.js", "newest kept");
  const left = acknowledgeHeartbeats([first, second, third], [second]);
  assertEqual(left.map((item) => item.fileName).join(","), "A.js,C.js", "only the sent one leaves");
});

check("retry backoff grows and then caps", () => {
  assertEqual(nextBackoffSeconds(1), 15, "first");
  assertEqual(nextBackoffSeconds(2), 30, "second");
  assertEqual(nextBackoffSeconds(3), 60, "third");
  assertEqual(nextBackoffSeconds(8), 300, "cap");
});

check("a heartbeat write is idempotent and carries no path and no password", () => {
  const heartbeat = beat("2026-10-22T10:00:00.000Z", 120, {
    editor: "cursor",
    projectName: "hub",
    fileName: "App.jsx",
    language: "javascript",
  });
  const request = buildInsertHeartbeatsRequest({
    url: "https://example.supabase.co/",
    anonKey: "anon",
    accessToken: "token",
    connectionId: "connection-a",
    heartbeats: [heartbeat],
  });
  assert(request.url.includes("/rest/v1/observations?on_conflict=id"), "upsert url");
  assertEqual(request.headers.Prefer, "resolution=ignore-duplicates,return=representation", "duplicates ignored");
  const body = JSON.parse(request.body);
  assertEqual(body[0].activity_kind, ACTIVITY_KIND, "kind");
  assertEqual(body[0].source, "collector", "source");
  assertEqual(body[0].editor, "cursor", "editor");
  assertEqual(body[0].file_name, "App.jsx", "file");
  assertEqual(body[0].window_title, null, "no window title");
  assertEqual(body[0].integration_id, "connection-a", "provenance");
  assert(!request.body.toLowerCase().includes("password"), "no password");
  assertThrows(
    () => toObservationRow({ ...heartbeat, fileName: "/tmp/secret.txt" }, "connection-a"),
    /not a path/
  );
});

check("a successful sync time is omitted until heartbeats are stored", () => {
  const request = buildUpsertIntegrationRequest({
    url: "https://example.supabase.co",
    anonKey: "anon",
    accessToken: "token",
    status: "syncing",
    config: { editor: "cursor", paused: false },
  });
  const body = JSON.parse(request.body);
  assertEqual(body.provider, "coding_tracker", "provider");
  assertEqual(body.status, "syncing", "status");
  assert(!("last_sync_at" in body), "success time is not cleared or invented");
  assert(!("last_error" in body), "an old error is left alone");
  const signIn = buildSignInRequest({
    url: "https://example.supabase.co",
    anonKey: "anon",
    email: "me@example.com",
    password: "secret",
  });
  assert(signIn.url.includes("grant_type=password"), "password grant");
  assert(!signIn.url.includes("secret"), "password stays out of the url");
});

console.log("\nApp contract");
check("the coding adapter is registered and refuses a path", () => {
  assertEqual(getAdapter("coding_tracker")?.id, "coding_tracker", "registered");
  assertEqual(EDITORS.join(","), "cursor,vscode", "editors");
  const parsed = codingTrackerAdapter.parse(
    JSON.stringify({
      version: 1,
      heartbeats: [
        {
          occurredAt: "2026-10-22T10:00:00.000Z",
          durationSeconds: 120,
          editor: "cursor",
          projectName: "hub",
          fileName: "App.jsx",
          language: "javascript",
        },
      ],
    })
  );
  const [observation] = codingTrackerAdapter.toObservations(parsed.records);
  assertEqual(observation.editor, "cursor", "editor");
  assertEqual(observation.fileName, "App.jsx", "file");
  assertEqual(observation.durationSeconds, 120, "duration");
  assertEqual(observation.source, "collector", "source");
  assertThrows(
    () =>
      codingTrackerAdapter.parse(
        JSON.stringify({
          heartbeats: [
            {
              occurredAt: "2026-10-22T10:00:00.000Z",
              durationSeconds: 10,
              editor: "vscode",
              fileName: "C:/secret/App.jsx",
            },
          ],
        })
      ),
    /not a path/
  );
});

check("the migration allows only the coding kind and the two editors", () => {
  const sql = readFileSync(
    path.join(root, "supabase/migrations/20261022140000_coding_activity.sql"),
    "utf8"
  );
  assert(sql.includes("activity_kind in ('coding')"), "kind check");
  assert(sql.includes("editor in ('cursor', 'vscode')"), "editor check");
  assert(sql.includes("public.observations does not exist"), "preflight");
});

check("a report range keeps the last day, and a local day has an exclusive end", () => {
  const from = new Date(2026, 9, 20, 0, 0, 0);
  const to = new Date(2026, 9, 22, 0, 0, 0);
  const bounds = reportRangeBounds(from, to);
  const end = Date.parse(bounds.to);
  assert(end > to.getTime(), "end is after the last day's start");
  assert(end - to.getTime() >= 23 * 60 * 60 * 1000, "covers the last day");
  assert(end - to.getTime() <= 25 * 60 * 60 * 1000, "does not swallow the next day");
  const range = localDayRange("2026-10-22", "UTC");
  assert(range.from < range.to, "day order");
  assertEqual(range.from, "2026-10-22T00:00:00.000Z", "utc start");
  assertEqual(range.to, "2026-10-23T00:00:00.000Z", "utc end");
});

function beat(occurredAt, durationSeconds, extra = {}) {
  return {
    occurredAt,
    durationSeconds,
    editor: extra.editor ?? "vscode",
    projectName: extra.projectName ?? "hub",
    fileName: extra.fileName ?? "App.jsx",
    language: extra.language ?? "javascript",
    isIdle: false,
    source: "collector",
    activityKind: "coding",
  };
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exit(1);
}
