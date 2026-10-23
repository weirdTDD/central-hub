// Sentral Hub — Phase 4C "time spent against plan" assertions.
//
// The repository has no test framework, so the domain rules are verified with plain
// Node assertions (same pattern as the time-tracking checks).
//
// Run:  node scripts/verify-planned-actual.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import {
  OPEN_TASK_STATUSES,
  summarizePlannedVsActual,
} from "../src/features/tracking/plannedVsActual.js";

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

const at = (seconds) => new Date(seconds * 1000).toISOString();

/** A task with its plan: `estimatedSeconds` null means "not estimated". */
const makeTask = (id, title, status, estimatedSeconds = null) => ({
  id,
  title,
  status,
  estimatedSeconds,
});

/** A session with its recorded time: `durationSeconds` null means "not recorded". */
const makeSession = (id, { taskId = null, durationSeconds = 1800, start = 0 } = {}) => ({
  id,
  startedAt: at(start),
  endedAt: at(start + (durationSeconds ?? 0)),
  durationSeconds,
  idleSeconds: null,
  source: "manual",
  taskId,
});

/** A raw correction row, exactly as the database stores it. */
const makeCorrection = (
  sessionId,
  { durationSeconds = 3600, start = 0, createdAt = 10 } = {}
) => ({
  id: `correction-${sessionId}`,
  session_id: sessionId,
  previous_started_at: at(start),
  previous_ended_at: at(start + 1800),
  previous_duration_seconds: 1800,
  corrected_started_at: at(start),
  corrected_ended_at: at(start + durationSeconds),
  corrected_duration_seconds: durationSeconds,
  reason: "manual correction",
  created_at: at(createdAt),
});

console.log("Sentral Hub — planned vs actual assertions\n");

console.log("Plan and recorded time");
check("a task with an estimate reports plan, actual and variance", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Write the spec", "in_progress", 3600)],
    sessions: [makeSession("s1", { taskId: "t1", durationSeconds: 1800 })],
  });

  assertEqual(rows.length, 1, "one row");
  assertEqual(rows[0].taskId, "t1", "task id");
  assertEqual(rows[0].title, "Write the spec", "title");
  assertEqual(rows[0].status, "in_progress", "status");
  assertEqual(rows[0].plannedSeconds, 3600, "the plan");
  assertEqual(rows[0].actualSeconds, 1800, "the recorded time");
  assertEqual(rows[0].sessionCount, 1, "one session");
  assertEqual(rows[0].sessionsWithoutDuration, 0, "the session has a duration");
  assertEqual(rows[0].varianceSeconds, -1800, "variance is actual - planned");
  assertEqual(rows[0].overPlan, false, "under the plan");
  assertEqual(totals.plannedSeconds, 3600, "planned total");
  assertEqual(totals.attributedSeconds, 1800, "attributed total");
  assertEqual(totals.actualSeconds, 1800, "actual total");
});

check("a task without an estimate has no plan, no variance and no verdict", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Unplanned work", "in_progress", null)],
    sessions: [makeSession("s1", { taskId: "t1", durationSeconds: 1800 })],
  });

  assertEqual(rows[0].plannedSeconds, null, "no plan");
  assertEqual(rows[0].varianceSeconds, null, "no variance");
  assertEqual(rows[0].overPlan, null, "no verdict");
  assertEqual(rows[0].actualSeconds, 1800, "the recorded time is still known");
  assertEqual(totals.plannedSeconds, 0, "no estimate means no planned total");
  assertEqual(totals.tasksWithoutEstimate, 1, "one task without an estimate");
});

check("a zero estimate is a real plan, not a missing one", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Zero plan", "todo", 0)],
    sessions: [],
  });

  assertEqual(rows[0].plannedSeconds, 0, "a zero-second plan stays zero");
  assertEqual(rows[0].varianceSeconds, 0, "variance against a zero plan");
  assertEqual(rows[0].overPlan, false, "no overrun");
  assertEqual(totals.plannedSeconds, 0, "the planned total is zero");
  assertEqual(totals.tasksWithoutEstimate, 0, "a zero estimate is an estimate");
});

check("a session without a recorded duration contributes no time", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Task", "in_progress", 3600)],
    sessions: [makeSession("s1", { taskId: "t1", durationSeconds: null })],
  });

  assertEqual(rows[0].actualSeconds, 0, "unrecorded time is not zero-length work");
  assertEqual(rows[0].sessionCount, 1, "the session is still a session");
  assertEqual(rows[0].sessionsWithoutDuration, 1, "the session has no duration");
  assertEqual(totals.actualSeconds, 0, "the total is not inflated");
  assertEqual(totals.attributedSeconds, 0, "the attributed total is not inflated");
  assertEqual(totals.sessionsWithoutDuration, 1, "one session without a duration");
});

console.log("\nAttribution");
check("an unattributed session lands in the unattributed total", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Task", "in_progress", 3600)],
    sessions: [makeSession("s1", { taskId: null, durationSeconds: 600 })],
  });

  assertEqual(totals.unattributedSeconds, 600, "the time is unattributed");
  assertEqual(totals.attributedSeconds, 0, "nothing is attributed");
  assertEqual(totals.actualSeconds, 600, "the time is still recorded");
  assertEqual(rows[0].actualSeconds, 0, "no task carries the time");
});

check("a session attributed to a task that no longer exists is unattributed", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Still there", "in_progress", 3600)],
    sessions: [makeSession("s1", { taskId: "deleted-task", durationSeconds: 900 })],
  });

  assertEqual(totals.unattributedSeconds, 900, "the time is unattributed");
  assertEqual(totals.attributedSeconds, 0, "nothing is attributed");
  assertEqual(rows.length, 1, "only the task in scope has a row");
  assertEqual(rows[0].actualSeconds, 0, "the deleted task is not in the rows");
});

check("a session without a duration is counted even when it is unattributed", () => {
  const { totals } = summarizePlannedVsActual({
    tasks: [],
    sessions: [makeSession("s1", { taskId: null, durationSeconds: null })],
  });

  assertEqual(totals.sessionsWithoutDuration, 1, "one session without a duration");
  assertEqual(totals.unattributedSeconds, 0, "no time to attribute");
  assertEqual(totals.sessionsInScope, 1, "the session is in scope");
});

console.log("\nCorrections");
check("a correction changes the recorded time", () => {
  const session = makeSession("s1", { taskId: "t1", durationSeconds: 1800 });
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Task", "in_progress", 7200)],
    sessions: [session],
    corrections: [makeCorrection("s1", { durationSeconds: 3600 })],
  });

  assertEqual(rows[0].actualSeconds, 3600, "the corrected time is the effective time");
  assertEqual(totals.attributedSeconds, 3600, "the corrected time is in the total");
  assertEqual(session.durationSeconds, 1800, "the original session row is untouched");
});

check("the latest correction wins", () => {
  const { rows } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Task", "in_progress", 7200)],
    sessions: [makeSession("s1", { taskId: "t1", durationSeconds: 1800 })],
    corrections: [
      makeCorrection("s1", { durationSeconds: 3600, createdAt: 10 }),
      makeCorrection("s1", { durationSeconds: 5400, createdAt: 20 }),
    ],
  });

  assertEqual(rows[0].actualSeconds, 5400, "the newest correction applies");
});

console.log("\nTotals");
check("the planned total counts only open tasks", () => {
  const { totals } = summarizePlannedVsActual({
    tasks: [
      makeTask("t1", "Open one", "todo", 3600),
      makeTask("t2", "Open two", "in_progress", 1800),
      makeTask("t3", "Done", "completed", 7200),
      makeTask("t4", "Dropped", "cancelled", 600),
    ],
    sessions: [],
  });

  assertEqual(totals.plannedSeconds, 5400, "only the open tasks are in the plan");
  assertEqual(totals.completedPlanSeconds, 7800, "the finished plan is reported apart");
  assertEqual(totals.tasksInScope, 4, "four tasks in scope");
});

check("the open tasks without an estimate are counted apart from the finished ones", () => {
  const { totals } = summarizePlannedVsActual({
    tasks: [
      makeTask("t1", "Open, no plan", "todo", null),
      makeTask("t2", "Done, no plan", "completed", null),
      makeTask("t3", "Open, with a plan", "in_progress", 3600),
    ],
    sessions: [],
  });

  assertEqual(totals.tasksWithoutEstimate, 2, "two tasks without an estimate");
  assertEqual(
    totals.openTasksWithoutEstimate,
    1,
    "only the open one leaves the plan incomplete"
  );
  assertEqual(
    totals.plannedSeconds,
    3600,
    "the plan counts the open task that has an estimate"
  );
});

check("a plan that no open task backs is zero, and it is known to be incomplete", () => {
  const { totals } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Open, no plan", "todo", null)],
    sessions: [],
  });

  assertEqual(totals.plannedSeconds, 0, "no estimate means no planned total");
  assertEqual(totals.openTasksWithoutEstimate, 1, "the open task has no estimate");
});

check("a task without sessions still appears with no recorded time", () => {
  const { rows } = summarizePlannedVsActual({
    tasks: [
      makeTask("t1", "With work", "in_progress", 3600),
      makeTask("t2", "Without work", "todo", 1800),
    ],
    sessions: [makeSession("s1", { taskId: "t1", durationSeconds: 600 })],
  });

  const withoutWork = rows.find((row) => row.taskId === "t2");
  assert(withoutWork, "the task without sessions has a row");
  assertEqual(withoutWork.actualSeconds, 0, "no recorded time");
  assertEqual(withoutWork.sessionCount, 0, "no sessions");
  assertEqual(withoutWork.plannedSeconds, 1800, "the plan is still shown");
  assertEqual(withoutWork.varianceSeconds, -1800, "the variance against the plan");
});

check("the totals add up", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [
      makeTask("t1", "One", "in_progress", 3600),
      makeTask("t2", "Two", "todo", 1800),
      makeTask("t3", "Three", "todo", null),
    ],
    sessions: [
      makeSession("s1", { taskId: "t1", durationSeconds: 1200 }),
      makeSession("s2", { taskId: "t2", durationSeconds: 2400 }),
      makeSession("s3", { taskId: "t3", durationSeconds: 300 }),
      makeSession("s4", { taskId: null, durationSeconds: 500 }),
      makeSession("s5", { taskId: "gone", durationSeconds: 100 }),
    ],
  });

  const rowSum = rows.reduce((sum, row) => sum + row.actualSeconds, 0);
  assertEqual(totals.attributedSeconds, rowSum, "attributed equals the sum of the rows");
  assertEqual(
    totals.actualSeconds,
    totals.attributedSeconds + totals.unattributedSeconds,
    "actual equals attributed plus unattributed"
  );
  assertEqual(totals.attributedSeconds, 3900, "attributed seconds");
  assertEqual(totals.unattributedSeconds, 600, "unattributed seconds");
  assertEqual(totals.actualSeconds, 4500, "all recorded seconds");
  assertEqual(totals.sessionsInScope, 5, "five sessions in scope");
  assertEqual(totals.tasksInScope, 3, "three tasks in scope");
  assertEqual(totals.tasksWithoutEstimate, 1, "one task without an estimate");
});

console.log("\nOrdering and verdicts");
check("over plan is true when the recorded time exceeds the plan", () => {
  const { rows } = summarizePlannedVsActual({
    tasks: [makeTask("t1", "Task", "in_progress", 1800)],
    sessions: [makeSession("s1", { taskId: "t1", durationSeconds: 3600 })],
  });

  assertEqual(rows[0].overPlan, true, "over the plan");
  assertEqual(rows[0].varianceSeconds, 1800, "the overrun");
});

check("the rows are sorted with the biggest overrun first", () => {
  const { rows } = summarizePlannedVsActual({
    tasks: [
      makeTask("t1", "Alpha", "in_progress", 3600),
      makeTask("t2", "Bravo", "in_progress", 1800),
      makeTask("t3", "Charlie", "in_progress", null),
    ],
    sessions: [
      makeSession("s1", { taskId: "t1", durationSeconds: 600 }),
      makeSession("s2", { taskId: "t2", durationSeconds: 5400 }),
      makeSession("s3", { taskId: "t3", durationSeconds: 600 }),
    ],
  });

  assertEqual(rows[0].taskId, "t2", "the biggest overrun first");
  assertEqual(rows[1].taskId, "t1", "then the task under its plan");
  assertEqual(rows[2].taskId, "t3", "a task without an estimate sorts last");
  assertEqual(rows[0].varianceSeconds, 3600, "the first variance");
  assertEqual(rows[1].varianceSeconds, -3000, "the second variance");
  assertEqual(rows[2].varianceSeconds, null, "no variance without an estimate");
});

check("rows with the same variance are sorted by title", () => {
  const { rows } = summarizePlannedVsActual({
    tasks: [
      makeTask("t2", "Bravo", "in_progress", 3600),
      makeTask("t1", "Alpha", "in_progress", 3600),
    ],
    sessions: [
      makeSession("s1", { taskId: "t1", durationSeconds: 3600 }),
      makeSession("s2", { taskId: "t2", durationSeconds: 3600 }),
    ],
  });

  assertEqual(rows[0].title, "Alpha", "alphabetically first");
  assertEqual(rows[1].title, "Bravo", "alphabetically second");
});

console.log("\nInput shapes");
check("raw database rows are accepted", () => {
  const { rows, totals } = summarizePlannedVsActual({
    tasks: [
      { id: "t1", title: "Raw task", status: "in_progress", estimated_duration_seconds: 3600 },
    ],
    sessions: [
      {
        id: "s1",
        started_at: at(0),
        ended_at: at(1800),
        duration_seconds: 1800,
        task_id: "t1",
      },
    ],
    corrections: [],
  });

  assertEqual(rows[0].plannedSeconds, 3600, "the estimate is read");
  assertEqual(rows[0].actualSeconds, 1800, "the duration is read");
  assertEqual(totals.attributedSeconds, 1800, "the attribution is read");
});

check("an empty input produces empty totals", () => {
  const { rows, totals } = summarizePlannedVsActual({});

  assertEqual(rows.length, 0, "no rows");
  assertEqual(totals.plannedSeconds, 0, "no plan");
  assertEqual(totals.completedPlanSeconds, 0, "no finished plan");
  assertEqual(totals.actualSeconds, 0, "no recorded time");
  assertEqual(totals.attributedSeconds, 0, "no attributed time");
  assertEqual(totals.unattributedSeconds, 0, "no unattributed time");
  assertEqual(totals.tasksWithoutEstimate, 0, "no task without an estimate");
  assertEqual(totals.sessionsWithoutDuration, 0, "no session without a duration");
  assertEqual(totals.tasksInScope, 0, "no task in scope");
  assertEqual(totals.sessionsInScope, 0, "no session in scope");
});

check("the open statuses are the task machine's active states", () => {
  assertEqual(
    OPEN_TASK_STATUSES.join(","),
    "todo,in_progress,in_review,blocked",
    "the open statuses"
  );
  assertEqual(
    summarizePlannedVsActual({
      tasks: [makeTask("t1", "Blocked", "blocked", 600)],
      openStatuses: OPEN_TASK_STATUSES,
    }).totals.plannedSeconds,
    600,
    "a blocked task is still open work"
  );
});

console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  for (const failure of failures) {
    console.error(` - ${failure.name}: ${failure.message}`);
  }
  process.exit(1);
}
