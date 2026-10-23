// Sentral Hub — Phase 4 time-tracking assertions.
//
// The repository has no test framework, so the domain rules are verified with plain
// Node assertions (same pattern as the task state-machine checks).
//
// Run:  node scripts/verify-tracking.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import {
  activeSeconds,
  applyCorrections,
  attributeSession,
  buildManualSession,
  buildSessions,
  groupSessionsByLocalDay,
  localDayKey,
  mergeIntervals,
  recomputeSessions,
  toEpochSeconds,
  toObservationShape,
  toSessionShape,
  unionDurationSeconds,
} from "../src/features/tracking/sessionUtils.js";

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

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

function assertThrowsWithMessage(fn, expectedMessage, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) throw new Error(message);
  if (thrown.message !== expectedMessage) {
    throw new Error(
      `${message} (expected message ${JSON.stringify(expectedMessage)}, got ${JSON.stringify(thrown.message)})`
    );
  }
}

const at = (seconds) => new Date(seconds * 1000).toISOString();
const observation = (id, offset, durationSeconds, extra = {}) => ({
  id,
  occurred_at: at(offset),
  duration_seconds: durationSeconds,
  is_idle: false,
  application: "VS Code",
  source: "collector",
  ...extra,
});

console.log("Sentral Hub — time tracking domain assertions\n");

console.log("Duration and overlap rule");
check("union counts overlapping intervals once", () => {
  assertEqual(
    unionDurationSeconds([
      { start: 0, end: 600 },
      { start: 300, end: 900 },
    ]),
    900,
    "union of [0,600) and [300,900) must be 900 seconds"
  );
});

check("union of disjoint intervals adds up", () => {
  assertEqual(
    unionDurationSeconds([
      { start: 0, end: 60 },
      { start: 600, end: 660 },
    ]),
    120,
    "disjoint intervals sum"
  );
});

check("union of an empty set is zero", () => {
  assertEqual(unionDurationSeconds([]), 0, "empty union");
});

check("touching intervals are merged", () => {
  assertEqual(
    mergeIntervals([
      { start: 0, end: 60 },
      { start: 60, end: 120 },
    ]).length,
    1,
    "touching intervals merge into one"
  );
});

check("invalid intervals are ignored", () => {
  assertEqual(
    unionDurationSeconds([
      { start: 10, end: 5 },
      { start: NaN, end: 20 },
    ]),
    0,
    "backwards and NaN intervals are dropped"
  );
});

console.log("\nSessionization");
check("observations within the gap threshold form one session", () => {
  const sessions = buildSessions([
    observation("a", 0, 60),
    observation("b", 120, 60),
  ]);
  assertEqual(sessions.length, 1, "one session");
  assertEqual(sessions[0].durationSeconds, 120, "duration of the session");
});

check("a gap larger than the threshold splits sessions", () => {
  const sessions = buildSessions([
    observation("a", 0, 60),
    observation("b", 1000, 60),
  ]);
  assertEqual(sessions.length, 2, "two sessions");
});

check("out-of-order observations are sorted before grouping", () => {
  const sessions = buildSessions([
    observation("b", 120, 60),
    observation("a", 0, 60),
  ]);
  assertEqual(sessions.length, 1, "one session");
  assertEqual(sessions[0].observationIds.length, 2, "both observations kept");
});

check("overlapping observations are not double-counted", () => {
  const sessions = buildSessions([
    observation("a", 0, 600),
    observation("b", 300, 600),
  ]);
  assertEqual(sessions[0].durationSeconds, 900, "union, not 1200");
});

check("a point event contributes no measured time but is kept", () => {
  const sessions = buildSessions([
    observation("a", 0, null),
    observation("b", 60, null),
  ]);
  assertEqual(sessions.length, 1, "one session");
  assertEqual(sessions[0].durationSeconds, null, "no measured coverage is missing, not zero");
  assertEqual(sessions[0].hasCoverage, false, "coverage is missing, not zero-valued");
  assertEqual(sessions[0].observationIds.length, 2, "both events recorded");
});

check("idle time is measured separately from the session duration", () => {
  const sessions = buildSessions([
    observation("a", 0, 300),
    observation("b", 300, 300, { is_idle: true }),
  ]);
  assertEqual(sessions[0].durationSeconds, 600, "total coverage");
  assertEqual(sessions[0].idleSeconds, 300, "idle coverage");
  assertEqual(activeSeconds(sessions[0]), 300, "active time");
});

check("active time is unknown when idle was never measured", () => {
  const sessions = buildSessions([observation("a", 0, 300)]);
  assertEqual(sessions[0].idleSeconds, 0, "no idle observed");
  assertEqual(activeSeconds(sessions[0]), 300, "active equals total");
  assertEqual(
    activeSeconds({ durationSeconds: 300, idleSeconds: null }),
    null,
    "unmeasured idle yields unknown active time"
  );
});

check("session boundaries follow the observations", () => {
  const sessions = buildSessions([
    observation("a", 0, 60),
    observation("b", 120, 60),
  ]);
  assertEqual(sessions[0].startedAt, at(0), "start");
  assertEqual(sessions[0].endedAt, at(180), "end");
});

console.log("\nLate and out-of-order events");
check("a late event rebuilds the affected window", () => {
  const first = buildSessions([observation("a", 0, 60)]);
  const withLate = buildSessions([
    observation("a", 0, 60),
    observation("late", 30, 60),
  ]);
  assertEqual(first[0].durationSeconds, 60, "before the late event");
  assertEqual(withLate[0].durationSeconds, 90, "after the late event (union)");
});

check("recomputeSessions replaces the stale session inside the window", () => {
  const previous = buildSessions([observation("a", 0, 60)]);
  const rebuilt = recomputeSessions(previous, [
    observation("a", 0, 60),
    observation("late", 30, 60),
  ]);
  assertEqual(rebuilt.length, 1, "one session after recompute");
  assertEqual(rebuilt[0].durationSeconds, 90, "rebuilt duration");
});

check("recomputeSessions keeps sessions outside the window", () => {
  const previous = buildSessions([
    observation("a", 0, 60),
    observation("far", 100000, 60),
  ]);
  const rebuilt = recomputeSessions(previous, [
    observation("a", 0, 60),
    observation("late", 30, 60),
  ]);
  assertEqual(rebuilt.length, 2, "the distant session survives");
});

check("recomputeSessions does not lose the time around a late event", () => {
  const previous = buildSessions([observation("a", 0, 1800)]);
  const rebuilt = recomputeSessions(previous, [observation("late", 1650, 100)]);
  const total = rebuilt.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  assertEqual(total, 1800, "the recorded 1800 s survives the recompute");
});

check("recomputeSessions keeps a straddling session's outside-window time", () => {
  const previous = buildSessions([observation("a", 0, 1800)]);
  const rebuilt = recomputeSessions(previous, [observation("late", 900, 100)]);
  const total = rebuilt.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
  assertEqual(total, 1800, "no recorded time is dropped");
  assert(
    rebuilt.some((s) => s.startedAt === at(0)),
    "the head of the straddling session is preserved"
  );
});

console.log("\nCorrections");
check("the latest correction wins and the original is preserved", () => {
  const session = { startedAt: at(0), endedAt: at(60), durationSeconds: 60 };
  const corrected = applyCorrections(session, [
    {
      created_at: at(10),
      corrected_started_at: at(0),
      corrected_ended_at: at(120),
      corrected_duration_seconds: 120,
      reason: "forgot the break",
    },
    {
      created_at: at(20),
      corrected_started_at: at(0),
      corrected_ended_at: at(180),
      corrected_duration_seconds: 180,
      reason: "second look",
    },
  ]);
  assertEqual(corrected.durationSeconds, 180, "latest correction applies");
  assertEqual(session.durationSeconds, 60, "the original session object is untouched");
  assertEqual(corrected.corrected, true, "flagged as corrected");
});

check("a session without corrections is returned unchanged", () => {
  const session = { startedAt: at(0), endedAt: at(60), durationSeconds: 60 };
  assertEqual(applyCorrections(session, []).durationSeconds, 60, "unchanged");
});

check("a correction duration follows its corrected interval", () => {
  const session = { startedAt: at(0), endedAt: at(60), durationSeconds: 60 };
  const corrected = applyCorrections(session, [
    {
      created_at: at(10),
      corrected_started_at: at(0),
      corrected_ended_at: at(120),
      reason: "forgot the break",
    },
  ]);
  assertEqual(corrected.durationSeconds, 120, "duration derived from the interval");
  assertEqual(corrected.correctionDurationMismatch, false, "no mismatch");
});

check("a correction whose duration contradicts its interval is flagged", () => {
  const session = { startedAt: at(0), endedAt: at(60), durationSeconds: 60 };
  const corrected = applyCorrections(session, [
    {
      created_at: at(10),
      corrected_started_at: at(0),
      corrected_ended_at: at(60),
      corrected_duration_seconds: 3600,
    },
  ]);
  assertEqual(corrected.correctionDurationMismatch, true, "mismatch reported");
});

console.log("\nTimezone and day boundaries");
check("the local day follows the user's timezone, not UTC", () => {
  const instant = "2026-10-20T17:00:00.000Z"; // 00:00 on 2026-10-21 in Bangkok
  assertEqual(localDayKey(instant, "UTC"), "2026-10-20", "UTC day");
  assertEqual(localDayKey(instant, "Asia/Bangkok"), "2026-10-21", "Bangkok day");
});

check("an unknown timezone falls back to UTC instead of throwing", () => {
  assertEqual(localDayKey("2026-10-20T17:00:00.000Z", "Not/AZone"), "2026-10-20", "fallback");
});

check("sessions group by local day", () => {
  const sessions = buildSessions([
    observation("a", 0, 60),
    observation("b", 86400, 60),
  ]);
  const byDay = groupSessionsByLocalDay(sessions, "UTC");
  assertEqual(byDay.size, 2, "two days");
});

console.log("\nAttribution");
check("a session without a task stays unattributed", () => {
  const attributed = attributeSession({ durationSeconds: 60 });
  assertEqual(attributed.taskId, null, "no task");
  assertEqual(attributed.attributionStatus, "unattributed", "status");
  assertEqual(attributed.attributionConfidence, null, "unknown confidence");
});

check("a manual attribution is confirmed", () => {
  const attributed = attributeSession(
    { durationSeconds: 60 },
    { taskId: "task-1", source: "manual", confidence: 1 }
  );
  assertEqual(attributed.attributionStatus, "confirmed", "status");
  assertEqual(attributed.taskId, "task-1", "task");
});

check("a rule attribution is only a suggestion", () => {
  const attributed = attributeSession(
    { durationSeconds: 60 },
    { taskId: "task-1", source: "rule", confidence: 0.7 }
  );
  assertEqual(attributed.attributionStatus, "suggested", "status");
});

check("a low-confidence rule attribution is uncertain", () => {
  const attributed = attributeSession(
    { durationSeconds: 60 },
    { taskId: "task-1", source: "rule", confidence: 0.2 }
  );
  assertEqual(attributed.attributionStatus, "uncertain", "status");
});

check("an invalid attribution source is rejected", () => {
  assertThrows(
    () => attributeSession({ durationSeconds: 60 }, { taskId: "t", source: "vibes" }),
    "unknown source must throw"
  );
});

check("a task without a source is accepted as unknown", () => {
  const attributed = attributeSession({ durationSeconds: 60 }, { taskId: "t" });
  assertEqual(attributed.taskId, "t", "task kept");
  assertEqual(attributed.attributionSource, null, "unknown source");
  assertEqual(attributed.attributionStatus, "uncertain", "status");
});

check("an invalid confidence is rejected", () => {
  assertThrows(
    () => attributeSession({ durationSeconds: 60 }, { taskId: "t", source: "rule", confidence: 1.5 }),
    "out-of-range confidence must throw"
  );
});

console.log("\nManual sessions");
check("a manual session has the documented shape", () => {
  const session = buildManualSession({
    startedAt: "2026-10-20T09:00:00.000Z",
    durationSeconds: 3600,
    timezone: "Asia/Bangkok",
    taskId: "task-1",
    application: "VS Code",
  });
  assertEqual(session.startedAt, "2026-10-20T09:00:00.000Z", "start time");
  assertEqual(session.endedAt, "2026-10-20T10:00:00.000Z", "end time is start + duration");
  assertEqual(session.durationSeconds, 3600, "duration");
  assertEqual(session.idleSeconds, null, "idle was never measured");
  assertEqual(session.source, "manual", "source");
  assertEqual(session.application, "VS Code", "application");
  assertEqual(session.timezone, "Asia/Bangkok", "timezone");
  assertEqual(session.taskId, "task-1", "task");
  assertEqual(session.observationIds.length, 0, "a manual session has no observations");
  assert(
    Array.isArray(session.observationIds),
    "observationIds is an array, not null"
  );
});

check("a manual session with a task is a confirmed manual attribution", () => {
  const session = buildManualSession({
    startedAt: "2026-10-20T09:00:00.000Z",
    durationSeconds: 600,
    taskId: "task-1",
  });
  assertEqual(session.attributionSource, "manual", "attribution source");
  assertEqual(session.attributionConfidence, 1, "attribution confidence");
  assertEqual(session.taskId, "task-1", "task kept");
});

check("a manual session without a task stays unattributed", () => {
  const session = buildManualSession({
    startedAt: "2026-10-20T09:00:00.000Z",
    durationSeconds: 600,
  });
  assertEqual(session.taskId, null, "no task");
  assertEqual(session.attributionSource, null, "no attribution source");
  assertEqual(session.attributionConfidence, null, "no attribution confidence");
});

check("a missing start time is rejected", () => {
  assertThrowsWithMessage(
    () => buildManualSession({ durationSeconds: 600 }),
    "A start time is required.",
    "a manual session without a start time must throw"
  );
});

check("an invalid start time is rejected", () => {
  assertThrowsWithMessage(
    () => buildManualSession({ startedAt: "not-a-date", durationSeconds: 600 }),
    "A start time is required.",
    "a manual session with an unparsable start time must throw"
  );
});

check("a negative duration is rejected", () => {
  assertThrowsWithMessage(
    () => buildManualSession({ startedAt: "2026-10-20T09:00:00.000Z", durationSeconds: -1 }),
    "The duration must be a number of seconds (0 or more).",
    "a negative duration must throw"
  );
});

check("a non-numeric duration is rejected", () => {
  assertThrowsWithMessage(
    () => buildManualSession({ startedAt: "2026-10-20T09:00:00.000Z", durationSeconds: "3600" }),
    "The duration must be a number of seconds (0 or more).",
    "a non-numeric duration must throw"
  );
});

check("a missing duration is rejected", () => {
  assertThrowsWithMessage(
    () => buildManualSession({ startedAt: "2026-10-20T09:00:00.000Z" }),
    "The duration must be a number of seconds (0 or more).",
    "a missing duration must throw"
  );
});

check("a Date start time is accepted and normalised to an ISO string", () => {
  const session = buildManualSession({
    startedAt: new Date("2026-10-20T09:00:00.000Z"),
    durationSeconds: 60,
  });
  assertEqual(session.startedAt, "2026-10-20T09:00:00.000Z", "start normalised to ISO");
  assertEqual(session.endedAt, "2026-10-20T09:01:00.000Z", "end time");
});

check("an ambiguous numeric start time is rejected", () => {
  assertThrowsWithMessage(
    () => buildManualSession({ startedAt: 1760000000000, durationSeconds: 60 }),
    "A start time is required.",
    "a bare number is not a readable start time"
  );
});

check("a zero duration is allowed and stays zero", () => {
  const session = buildManualSession({
    startedAt: "2026-10-20T09:00:00.000Z",
    durationSeconds: 0,
  });
  assertEqual(session.durationSeconds, 0, "a stated instant is a real zero, not null");
  assertEqual(session.endedAt, session.startedAt, "an instant ends where it starts");
  assertEqual(session.idleSeconds, null, "idle was never measured");
});

console.log("\nShape mapping");
check("a missing duration stays missing", () => {
  const shape = toObservationShape({ id: "o1", duration_seconds: null, occurred_at: at(0) });
  assertEqual(shape.durationSeconds, null, "null duration");
  assertEqual(shape.isIdle, false, "idle flag");
});

check("session shape keeps an unmeasured idle as null", () => {
  const shape = toSessionShape({
    id: "s1",
    duration_seconds: 60,
    idle_seconds: null,
    attribution_confidence: null,
    observation_ids: ["o1"],
  });
  assertEqual(shape.idleSeconds, null, "idle not measured");
  assertEqual(shape.attributionConfidence, null, "confidence unknown");
  assertEqual(shape.observationIds.length, 1, "observation linkage");
});

check("invalid dates do not become epoch zero", () => {
  assertEqual(toEpochSeconds("not-a-date"), null, "invalid date");
});

console.log(
  `\n${passed} passed, ${failures.length} failed`
);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  for (const failure of failures) {
    console.error(` - ${failure.name}: ${failure.message}`);
  }
  process.exit(1);
}
