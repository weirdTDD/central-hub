// Sentral Hub — Phase 5 integration framework assertions.
//
// The repository has no test framework, so the integration contract is verified
// with plain Node assertions (same pattern as the tracking and contract scripts).
//
// Run:  node scripts/verify-integrations.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import {
  DOCUMENTATION_FIELDS,
  INTEGRATION_STATUSES,
  STATUS_TRANSITIONS,
  SYNC_RUN_STATUSES,
  assertLegalStatusTransition,
  getAdapter,
  isLegalStatusTransition,
  listAdapters,
} from "../src/features/integrations/contract.js";
import {
  deterministicUuid,
  scopeObservationId,
  stableHash,
} from "../src/features/integrations/ids.js";
import { localActivityFileAdapter } from "../src/features/integrations/adapters/localActivityFile.js";
import { vscodeHistoryAdapter } from "../src/features/integrations/adapters/vscodeHistory.js";
import { browserHistoryAdapter } from "../src/features/integrations/adapters/browserHistory.js";

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
    throw new Error(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

/** Asserts that the call throws AND that the message contains `fragment`. */
function assertThrowsWith(fn, fragment, message) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(message);
  if (!String(error.message).includes(fragment)) {
    throw new Error(
      `${message} (message was "${error.message}", expected it to contain "${fragment}")`
    );
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RECORD = {
  occurred_at: "2026-10-20T09:00:00.000Z",
  duration_seconds: 900,
  application: "Visual Studio Code",
  window_title: "src/lib/tracking.js",
  idle: false,
};

const objectFile = JSON.stringify({
  version: 1,
  source: "test-export",
  records: [RECORD],
});

const arrayFile = JSON.stringify([RECORD]);

console.log("Sentral Hub — integration framework assertions\n");

console.log("Stable identity");
check("stableHash returns 32 lowercase hex characters", () => {
  const hash = stableHash("local_activity_file|2026-10-20T09:00:00.000Z");
  assert(/^[0-9a-f]{32}$/.test(hash), `not a 32-char lowercase hex string: ${hash}`);
});

check("stableHash is deterministic", () => {
  assertEqual(
    stableHash("same input"),
    stableHash("same input"),
    "the same input must hash to the same value"
  );
});

check("stableHash separates different inputs", () => {
  assert(
    stableHash("input a") !== stableHash("input b"),
    "different inputs must not collide"
  );
});

check("deterministicUuid is a version-5 shaped uuid", () => {
  const uuid = deterministicUuid("local_activity_file|x|y|");
  assert(UUID_PATTERN.test(uuid), `not a uuid-shaped identifier: ${uuid}`);
});

check("deterministicUuid is deterministic", () => {
  assertEqual(
    deterministicUuid("same input"),
    deterministicUuid("same input"),
    "the same input must yield the same id"
  );
});

check("deterministicUuid separates different inputs", () => {
  assert(
    deterministicUuid("input a") !== deterministicUuid("input b"),
    "different inputs must not share an id"
  );
});

console.log("\nAdapter contract");
check("the registry is not empty", () => {
  assert(listAdapters().length > 0, "no adapters are registered");
});

check("getAdapter finds a registered adapter and ignores unknown ids", () => {
  assertEqual(
    getAdapter("local_activity_file")?.id,
    "local_activity_file",
    "the local activity file adapter is registered"
  );
  assertEqual(getAdapter("nope"), undefined, "an unknown id returns undefined");
});

check("every adapter carries an id, a label, a summary and a removal policy", () => {
  for (const adapter of listAdapters()) {
    assert(typeof adapter.id === "string" && adapter.id.length > 0, "adapter id");
    assert(typeof adapter.label === "string" && adapter.label.length > 0, `${adapter.id}: label`);
    assert(
      typeof adapter.summary === "string" && adapter.summary.length > 0,
      `${adapter.id}: summary`
    );
    assert(
      typeof adapter.removalPolicy === "string" && adapter.removalPolicy.length > 0,
      `${adapter.id}: removalPolicy`
    );
  }
});

check("every adapter states whether it is implemented", () => {
  for (const adapter of listAdapters()) {
    assert(
      typeof adapter.implemented === "boolean",
      `${adapter.id}: implemented must be true or false`
    );
  }
});

check("every adapter documents all ten contract fields", () => {
  assertEqual(DOCUMENTATION_FIELDS.length, 10, "the contract has ten fields");
  for (const adapter of listAdapters()) {
    for (const field of DOCUMENTATION_FIELDS) {
      const value = adapter.documentation?.[field];
      assert(
        typeof value === "string" && value.trim().length > 0,
        `${adapter.id}: documentation.${field} is missing or empty`
      );
    }
  }
});

check("every adapter implements parse and toObservations", () => {
  for (const adapter of listAdapters()) {
    assert(typeof adapter.parse === "function", `${adapter.id}: parse`);
    assert(typeof adapter.toObservations === "function", `${adapter.id}: toObservations`);
  }
});

check("VS Code history keeps the file name and drops the path", () => {
  const parsed = vscodeHistoryAdapter.parse(
    JSON.stringify({
      version: 1,
      records: [{ occurred_at: "2026-10-01T12:00:00.000Z", file_name: "App.jsx" }],
    })
  );
  const [observation] = vscodeHistoryAdapter.toObservations(parsed.records);
  assertEqual(observation.application, "Visual Studio Code", "application");
  assertEqual(observation.windowTitle, "App.jsx", "file name");
  assertEqual(observation.durationSeconds, null, "an edit has no measured duration");
  assertEqual(observation.source, "import", "source");
  assertThrows(
    () =>
      vscodeHistoryAdapter.parse(
        JSON.stringify({
          version: 1,
          records: [{ occurred_at: "2026-10-01T12:00:00.000Z", file_name: "C:/secret/App.jsx" }],
        })
      ),
    /file name, not a path/,
    "a path must be refused"
  );
});

check("browser history keeps the host and drops an unmeasured duration", () => {
  const parsed = browserHistoryAdapter.parse(
    JSON.stringify({
      version: 1,
      records: [
        { occurred_at: "2026-10-17T12:00:00.000Z", host: "GitHub.com", duration_seconds: 90 },
        { occurred_at: "2026-10-17T12:05:00.000Z", host: "example.com", duration_seconds: 0 },
      ],
    })
  );
  const observations = browserHistoryAdapter.toObservations(parsed.records);
  assertEqual(observations[0].application, "github.com", "host is lowercased");
  assertEqual(observations[0].windowTitle, null, "page title is not stored");
  assertEqual(observations[0].durationSeconds, 90, "measured duration");
  assertEqual(observations[1].durationSeconds, null, "zero duration stays missing");
  assertThrows(
    () =>
      browserHistoryAdapter.parse(
        JSON.stringify({
          version: 1,
          records: [{ occurred_at: "2026-10-17T12:00:00.000Z", host: "https://github.com/private", duration_seconds: 1 }],
        })
      ),
    /not a URL/,
    "a full URL must be refused"
  );
});

console.log("\nStatus transitions");
check("the documented states are the ones the app shows", () => {
  assertEqual(
    JSON.stringify(INTEGRATION_STATUSES),
    JSON.stringify(["disconnected", "connecting", "connected", "syncing", "error"]),
    "integration statuses"
  );
  assertEqual(
    JSON.stringify(SYNC_RUN_STATUSES),
    JSON.stringify(["running", "success", "error"]),
    "sync run statuses"
  );
});

check("the transition table is the documented flow", () => {
  const expected = {
    disconnected: ["connecting"],
    connecting: ["syncing", "connected", "error", "disconnected"],
    syncing: ["connected", "error"],
    connected: ["syncing", "disconnected"],
    error: ["connecting", "disconnected"],
  };
  assertEqual(
    JSON.stringify(STATUS_TRANSITIONS),
    JSON.stringify(expected),
    "the transition table"
  );
});

check("the legal transitions are accepted", () => {
  const legal = [
    ["disconnected", "connecting"],
    ["connecting", "syncing"],
    ["connecting", "connected"],
    ["connecting", "error"],
    ["connecting", "disconnected"],
    ["syncing", "connected"],
    ["syncing", "error"],
    ["connected", "syncing"],
    ["connected", "disconnected"],
    ["error", "connecting"],
    ["error", "disconnected"],
  ];
  for (const [from, to] of legal) {
    assert(
      isLegalStatusTransition(from, to),
      `${from} -> ${to} must be legal`
    );
  }
});

check("the illegal transitions are rejected", () => {
  const illegal = [
    ["disconnected", "syncing"],
    ["disconnected", "connected"],
    ["disconnected", "error"],
    ["syncing", "disconnected"],
    ["syncing", "connecting"],
    ["connected", "connecting"],
    ["connected", "connected"],
    ["connected", "error"],
    ["error", "syncing"],
    ["error", "connected"],
    ["error", "error"],
    ["nonsense", "connecting"],
    ["disconnected", "nonsense"],
  ];
  for (const [from, to] of illegal) {
    assert(
      !isLegalStatusTransition(from, to),
      `${from} -> ${to} must be illegal`
    );
  }
});

check("the import flow is connecting -> syncing -> connected", () => {
  assert(
    isLegalStatusTransition("connecting", "syncing"),
    "connecting -> syncing must be legal"
  );
  assert(
    isLegalStatusTransition("syncing", "connected"),
    "syncing -> connected must be legal"
  );
});

check("a repeat import goes straight from connected to syncing", () => {
  assert(
    isLegalStatusTransition("connected", "syncing"),
    "connected -> syncing must be legal"
  );
  assert(
    !isLegalStatusTransition("connected", "connecting"),
    "a repeat import must not reconnect: connected -> connecting must be illegal"
  );
});

check("an import cannot skip the connection", () => {
  assert(
    !isLegalStatusTransition("disconnected", "syncing"),
    "disconnected -> syncing must be illegal: the connection comes first"
  );
  assert(
    !isLegalStatusTransition("disconnected", "connected"),
    "disconnected -> connected must be illegal"
  );
});

check("a failed connection has to be connected again before it syncs", () => {
  assert(
    isLegalStatusTransition("error", "connecting"),
    "error -> connecting must be legal"
  );
  assert(
    !isLegalStatusTransition("error", "syncing"),
    "error -> syncing must be illegal: the connection comes first"
  );
});

check("every documented status has a transition list", () => {
  for (const status of INTEGRATION_STATUSES) {
    assert(
      Array.isArray(STATUS_TRANSITIONS[status]),
      `${status} has no transition list`
    );
  }
});

check("assertLegalStatusTransition accepts a legal move", () => {
  assertLegalStatusTransition("connecting", "syncing");
  assertLegalStatusTransition("syncing", "connected");
  assertLegalStatusTransition("connected", "syncing");
  assertLegalStatusTransition("error", "connecting");
});

check("assertLegalStatusTransition refuses an illegal move", () => {
  const illegal = [
    ["disconnected", "syncing"],
    ["disconnected", "connected"],
    ["error", "syncing"],
    ["connected", "connecting"],
    ["nonsense", "connecting"],
  ];
  for (const [from, to] of illegal) {
    assertThrows(
      () => assertLegalStatusTransition(from, to),
      `${from} -> ${to} must throw`
    );
  }
});

check("assertLegalStatusTransition explains the refusal", () => {
  assertThrowsWith(
    () => assertLegalStatusTransition("disconnected", "syncing"),
    "disconnected",
    "the message must name the statuses"
  );
});

console.log("\nLocal activity file — parsing");
check("the documented object shape is accepted", () => {
  const parsed = localActivityFileAdapter.parse(objectFile);
  assertEqual(parsed.records.length, 1, "one record");
  assertEqual(parsed.records[0].occurredAt, "2026-10-20T09:00:00.000Z", "occurredAt");
  assertEqual(parsed.records[0].durationSeconds, 900, "durationSeconds");
  assertEqual(parsed.records[0].application, "Visual Studio Code", "application");
  assertEqual(parsed.records[0].windowTitle, "src/lib/tracking.js", "windowTitle");
  assertEqual(parsed.records[0].isIdle, false, "isIdle");
});

check("the documented bare array shape is accepted", () => {
  const parsed = localActivityFileAdapter.parse(arrayFile);
  assertEqual(parsed.records.length, 1, "one record");
  assertEqual(parsed.records[0].occurredAt, "2026-10-20T09:00:00.000Z", "occurredAt");
  assertEqual(parsed.records[0].durationSeconds, 900, "durationSeconds");
});

check("both documented shapes produce the same records", () => {
  assertEqual(
    JSON.stringify(localActivityFileAdapter.parse(objectFile).records),
    JSON.stringify(localActivityFileAdapter.parse(arrayFile).records),
    "the two shapes must normalise identically"
  );
});

check("optional fields that are absent stay missing", () => {
  const parsed = localActivityFileAdapter.parse(
    JSON.stringify([{ occurred_at: "2026-10-20T09:00:00.000Z" }])
  );
  assertEqual(parsed.records[0].durationSeconds, null, "a missing duration is null, not 0");
  assertEqual(parsed.records[0].application, null, "a missing application is null");
  assertEqual(parsed.records[0].windowTitle, null, "a missing window title is null");
  assertEqual(parsed.records[0].isIdle, false, "a missing idle flag is false");
});

check("unknown extra fields are ignored", () => {
  const parsed = localActivityFileAdapter.parse(
    JSON.stringify([
      { occurred_at: "2026-10-20T09:00:00.000Z", pid: 4242, tags: ["a", "b"] },
    ])
  );
  assertEqual(parsed.records.length, 1, "the record is still parsed");
  assertEqual(parsed.records[0].occurredAt, "2026-10-20T09:00:00.000Z", "occurredAt");
});

check("a timestamp is normalised to UTC", () => {
  const parsed = localActivityFileAdapter.parse(
    JSON.stringify([{ occurred_at: "2026-10-20T16:00:00+07:00" }])
  );
  assertEqual(parsed.records[0].occurredAt, "2026-10-20T09:00:00.000Z", "UTC ISO-8601");
});

check("invalid JSON is rejected", () => {
  assertThrowsWith(
    () => localActivityFileAdapter.parse("{ not json"),
    "not valid JSON",
    "malformed JSON must be reported clearly"
  );
});

check("a JSON object without a records array is rejected", () => {
  assertThrowsWith(
    () => localActivityFileAdapter.parse(JSON.stringify({ version: 1 })),
    "records",
    "an object without records must be reported clearly"
  );
});

check("a JSON value that is neither shape is rejected", () => {
  assertThrows(
    () => localActivityFileAdapter.parse(JSON.stringify("hello")),
    "a bare string must be rejected"
  );
  assertThrows(
    () => localActivityFileAdapter.parse(JSON.stringify(42)),
    "a bare number must be rejected"
  );
});

check("a record that is not an object is rejected", () => {
  assertThrowsWith(
    () => localActivityFileAdapter.parse(JSON.stringify(["not a record"])),
    "Record 0",
    "a non-object record must name its index"
  );
});

check("a record without occurred_at is rejected and the index is named", () => {
  assertThrowsWith(
    () =>
      localActivityFileAdapter.parse(
        JSON.stringify([
          { occurred_at: "2026-10-20T09:00:00.000Z" },
          { occurred_at: "2026-10-20T10:00:00.000Z" },
          { occurred_at: "2026-10-20T11:00:00.000Z" },
          { duration_seconds: 60 },
        ])
      ),
    "Record 3",
    "the message must name the offending record index"
  );
});

check("a record with an unparseable occurred_at is rejected", () => {
  assertThrowsWith(
    () =>
      localActivityFileAdapter.parse(
        JSON.stringify([{ occurred_at: "not-a-timestamp" }])
      ),
    "Record 0",
    "an invalid timestamp must name the record"
  );
});

check("a negative duration is rejected and the index is named", () => {
  assertThrowsWith(
    () =>
      localActivityFileAdapter.parse(
        JSON.stringify([
          { occurred_at: "2026-10-20T09:00:00.000Z" },
          { occurred_at: "2026-10-20T10:00:00.000Z", duration_seconds: -5 },
        ])
      ),
    "Record 1",
    "the message must name the offending record index"
  );
});

check("a failed import leaves nothing behind", () => {
  let threw = false;
  try {
    localActivityFileAdapter.parse(
      JSON.stringify([{ occurred_at: "not-a-timestamp" }])
    );
  } catch {
    threw = true;
  }
  assert(threw, "the malformed file must fail the whole run");
});

console.log("\nLocal activity file — observations");
check("an observation carries the documented fields", () => {
  const observations = localActivityFileAdapter.toObservations(
    localActivityFileAdapter.parse(objectFile).records
  );
  assertEqual(observations.length, 1, "one observation");
  const observation = observations[0];
  assertEqual(observation.occurredAt, "2026-10-20T09:00:00.000Z", "occurredAt");
  assertEqual(observation.durationSeconds, 900, "durationSeconds");
  assertEqual(observation.application, "Visual Studio Code", "application");
  assertEqual(observation.windowTitle, "src/lib/tracking.js", "windowTitle");
  assertEqual(observation.isIdle, false, "isIdle");
  assertEqual(observation.source, "import", "source");
});

check("the observation id is a uuid", () => {
  const observations = localActivityFileAdapter.toObservations(
    localActivityFileAdapter.parse(objectFile).records
  );
  assert(
    UUID_PATTERN.test(observations[0].id),
    `not a uuid-shaped id: ${observations[0].id}`
  );
});

check("the same record always produces the same id", () => {
  const records = localActivityFileAdapter.parse(objectFile).records;
  const first = localActivityFileAdapter.toObservations(records);
  const second = localActivityFileAdapter.toObservations(records);
  assertEqual(first[0].id, second[0].id, "the id must be stable");
});

check("different records produce different ids", () => {
  const records = localActivityFileAdapter.parse(
    JSON.stringify([
      { occurred_at: "2026-10-20T09:00:00.000Z", duration_seconds: 900 },
      { occurred_at: "2026-10-20T10:00:00.000Z", duration_seconds: 900 },
      { occurred_at: "2026-10-20T09:00:00.000Z", duration_seconds: 60 },
    ])
  ).records;
  const ids = localActivityFileAdapter.toObservations(records).map((o) => o.id);
  assertEqual(new Set(ids).size, ids.length, "every record needs its own id");
});

check("importing the same file twice yields identical ids", () => {
  const first = localActivityFileAdapter.toObservations(
    localActivityFileAdapter.parse(objectFile).records
  );
  const second = localActivityFileAdapter.toObservations(
    localActivityFileAdapter.parse(objectFile).records
  );
  assertEqual(
    JSON.stringify(first.map((o) => o.id)),
    JSON.stringify(second.map((o) => o.id)),
    "a repeated import must be a no-op"
  );
});

check("imported observations carry source 'import'", () => {
  const observations = localActivityFileAdapter.toObservations(
    localActivityFileAdapter.parse(objectFile).records
  );
  for (const observation of observations) {
    assertEqual(observation.source, "import", "source");
  }
});

check("a missing duration stays null in the observation", () => {
  const records = localActivityFileAdapter.parse(
    JSON.stringify([{ occurred_at: "2026-10-20T09:00:00.000Z" }])
  ).records;
  const observation = localActivityFileAdapter.toObservations(records)[0];
  assertEqual(observation.durationSeconds, null, "missing is null, never 0");
});

check("a missing idle flag stays false", () => {
  const records = localActivityFileAdapter.parse(
    JSON.stringify([{ occurred_at: "2026-10-20T09:00:00.000Z" }])
  ).records;
  const observation = localActivityFileAdapter.toObservations(records)[0];
  assertEqual(observation.isIdle, false, "idle defaults to false");
});

console.log("\nConnection-scoped observation ids");
check("scoping an id to a connection is deterministic", () => {
  const first = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1");
  const second = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1");
  assertEqual(first, second, "the same record under the same connection must yield the same id");
});

check("a scoped id is a uuid", () => {
  const id = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1");
  assert(UUID_PATTERN.test(id), `not a uuid-shaped id: ${id}`);
});

check("the same record under two different connections yields two different ids", () => {
  // WHY: `public.observations.id` is a GLOBAL primary key. Two accounts that
  // import the same file have different connections, so their ids must not
  // collide — otherwise the second account's import is silently swallowed.
  const alice = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1");
  const bob = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "dddddddd-0000-0000-0000-0000000000d1");
  assert(alice !== bob, "two connections must not produce the same observation id");
});

check("two different records under one connection yield two different ids", () => {
  const first = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1");
  const second = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a2", "cccccccc-0000-0000-0000-0000000000c1");
  assert(first !== second, "two records must not share an observation id");
});

check("the adapter's record identity survives the scoping unchanged in meaning", () => {
  // The adapter still derives the id from the record alone; the engine scopes
  // it afterwards. Scoping twice must not be the same as scoping once.
  const once = scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1");
  const twice = scopeObservationId(scopeObservationId("aaaaaaaa-0000-0000-0000-0000000000a1", "cccccccc-0000-0000-0000-0000000000c1"), "cccccccc-0000-0000-0000-0000000000c1");
  assert(once !== twice, "the scoping must actually change the id");
});

console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  for (const failure of failures) {
    console.error(` - ${failure.name}: ${failure.message}`);
  }
  process.exit(1);
}
