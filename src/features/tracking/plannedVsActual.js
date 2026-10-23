// Sentral Hub — "time spent against plan": the rules that compare the PLAN with
// the RECORDED time.
//
// The PLAN is a task's estimate (`tasks.estimated_duration_seconds`, whole
// seconds, NULL = "not estimated"). The RECORDED time is a session
// (`sessions.duration_seconds`, whole seconds, NULL = "not recorded"), optionally
// attributed to one task, and correctable through a correction that lives BESIDE
// the session instead of overwriting it.
//
// WHY THE TOTALS COME FROM SESSIONS ONLY (docs/DECISIONS.md D-007):
// `work_logs` is a SEPARATE manual log and `sessions` is the recorded time
// stream. They can describe the SAME work, so adding `work_logs.duration_seconds`
// to `sessions.duration_seconds` would count that work twice. This module
// therefore takes SESSIONS and TASKS — and never a log.
//
// WHY the module is PURE (no React, no network, no browser APIs): the rules
// must be verifiable with plain Node assertions — see
// scripts/verify-planned-actual.mjs.

import { applyCorrections } from "./sessionUtils.js";

/**
 * The task statuses that still count as "open work".
 *
 * A task that is not open (completed, cancelled) is FINISHED: its estimate is
 * reported apart (`completedPlanSeconds`) so the remaining plan is not inflated
 * by work that is already done.
 */
export const OPEN_TASK_STATUSES = ["todo", "in_progress", "in_review", "blocked"];

/**
 * Reads a value that may be spelled in camelCase or snake_case.
 *
 * The domain accepts both spellings so a caller can pass a raw database row or
 * an already-mapped UI shape without the rules caring which one it got.
 */
function readValue(row, camelKey, snakeKey) {
  if (!row || typeof row !== "object") return undefined;
  if (camelKey in row) return row[camelKey];
  if (snakeKey in row) return row[snakeKey];
  return undefined;
}

/**
 * Normalises a session row to the camelCase shape `applyCorrections` expects.
 *
 * The ORIGINAL values are kept as they are: a correction is a separate record
 * and never rewrites the session row.
 */
function toSessionInput(row) {
  const duration = readValue(row, "durationSeconds", "duration_seconds");
  const taskId = readValue(row, "taskId", "task_id");
  return {
    ...row,
    id: row?.id ?? null,
    startedAt: readValue(row, "startedAt", "started_at") ?? null,
    endedAt: readValue(row, "endedAt", "ended_at") ?? null,
    durationSeconds:
      duration === null || duration === undefined ? null : Number(duration),
    taskId:
      taskId === null || taskId === undefined || taskId === "" ? null : taskId,
  };
}

/**
 * Normalises a task row to the shape the summary needs.
 *
 * `estimatedSeconds` is the plan in whole seconds, or `null` when the task has
 * NO estimate. NULL is "not estimated" and is never turned into 0.
 */
function toTaskInput(row) {
  const estimate =
    readValue(row, "estimatedSeconds", "estimated_duration_seconds") ??
    readValue(row, "estimatedDurationSeconds", "estimated_duration_seconds");
  return {
    id: row?.id ?? null,
    title: row?.title ?? "",
    status: row?.status ?? null,
    estimatedSeconds:
      estimate === null || estimate === undefined ? null : Number(estimate),
  };
}

/**
 * Groups the raw correction rows by the session they correct.
 *
 * The correction rows are raw database rows (`session_id`, `corrected_*`,
 * `previous_*`, `reason`, `created_at`).
 */
function groupCorrectionsBySession(corrections) {
  const grouped = new Map();
  for (const correction of corrections ?? []) {
    const sessionId = readValue(correction, "sessionId", "session_id");
    if (sessionId === null || sessionId === undefined) continue;
    const list = grouped.get(sessionId) ?? [];
    list.push(correction);
    grouped.set(sessionId, list);
  }
  return grouped;
}

/**
 * The effective duration of a session, or null when no time was recorded.
 *
 * A session whose duration is null is UNRECORDED time, not a zero-length
 * session: it contributes nothing to the totals and is counted separately.
 */
function effectiveDurationSeconds(effective) {
  const value = effective?.durationSeconds;
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric > 0 ? numeric : 0;
}

/**
 * Compares two rows by title, deterministically (code point order).
 */
function compareTitles(a, b) {
  const left = String(a?.title ?? "");
  const right = String(b?.title ?? "");
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Compares the planned-vs-actual rows: the biggest overrun first, then by
 * title. A row without an estimate has no variance and sorts LAST.
 */
function compareRows(a, b) {
  const left = a.varianceSeconds;
  const right = b.varianceSeconds;
  if (left === null && right === null) return compareTitles(a, b);
  if (left === null) return 1;
  if (right === null) return -1;
  if (right !== left) return right - left;
  return compareTitles(a, b);
}

/**
 * Summarises the recorded time against the plan.
 *
 * @param {object} [input]
 * @param {Array<object>} [input.sessions] the sessions in scope. A session may be a
 *   raw database row or an already-mapped shape; the effective values come from
 *   `applyCorrections`, so a correction changes the recorded time while the
 *   original session row keeps its own values.
 * @param {Array<object>} [input.tasks] the tasks in scope. Each carries its plan:
 *   `estimatedSeconds` (or `estimated_duration_seconds`), `null` = not estimated.
 * @param {Array<object>} [input.corrections] the raw correction rows, grouped by
 *   `session_id` inside the module.
 * @param {string[]} [input.openStatuses] the statuses that count as open work.
 * @returns {{
 *   rows: Array<{
 *     taskId: string|null,
 *     title: string,
 *     status: string|null,
 *     plannedSeconds: number|null,
 *     actualSeconds: number,
 *     sessionCount: number,
 *     sessionsWithoutDuration: number,
 *     varianceSeconds: number|null,
 *     overPlan: boolean|null
 *   }>,
 *   totals: {
 *     plannedSeconds: number,
 *     completedPlanSeconds: number,
 *     actualSeconds: number,
 *     attributedSeconds: number,
 *     unattributedSeconds: number,
 *     tasksWithoutEstimate: number,
 *     openTasksWithoutEstimate: number,
 *     sessionsWithoutDuration: number,
 *     tasksInScope: number,
 *     sessionsInScope: number
 *   }
 * }}
 *
 * The totals mean:
 *   - `plannedSeconds` — the estimates of the OPEN tasks that HAVE one. The plan
 *     that is still ahead.
 *   - `completedPlanSeconds` — the estimates of the finished tasks, reported apart
 *     so the remaining plan is not inflated.
 *   - `actualSeconds` — ALL the effective recorded time in scope. It always equals
 *     `attributedSeconds + unattributedSeconds`.
 *   - `attributedSeconds` — the part attributed to a task; it equals the sum of the
 *     per-row `actualSeconds`.
 *   - `unattributedSeconds` — recorded time with no task, or with a task that no
 *     longer exists.
 *   - `tasksWithoutEstimate` — how many tasks in scope have NO estimate.
 *   - `openTasksWithoutEstimate` — how many of those are OPEN. The PLAN is the
 *     estimate of the open tasks, so an open task without an estimate makes the
 *     plan incomplete (and a difference against it is not a fact), while a
 *     finished task without an estimate does not.
 *   - `sessionsWithoutDuration` — how many sessions IN SCOPE have no recorded
 *     duration (attributed and unattributed alike). The per-row field counts only
 *     that task's own sessions, so the two do not have to be equal.
 */
export function summarizePlannedVsActual({
  sessions = [],
  tasks = [],
  corrections = [],
  openStatuses = OPEN_TASK_STATUSES,
} = {}) {
  const open = new Set(openStatuses ?? []);
  const taskList = (tasks ?? []).map(toTaskInput);
  const taskById = new Map(taskList.map((task) => [task.id, task]));
  const sessionList = (sessions ?? []).map(toSessionInput);
  const correctionsBySession = groupCorrectionsBySession(corrections);

  const perTask = new Map();
  let unattributedSeconds = 0;
  let sessionsWithoutDuration = 0;

  for (const session of sessionList) {
    // The effective values: the session's own values, with the LATEST correction
    // for that session applied on top. The correction is a separate record, so the
    // session row itself is never rewritten.
    const effective = applyCorrections(
      session,
      correctionsBySession.get(session.id) ?? []
    );
    const duration = effectiveDurationSeconds(effective);
    const hasDuration = duration !== null;

    // WHY a session without a duration contributes 0: its time was NEVER
    // RECORDED. Reporting it as 0 would claim the work took no time, and
    // reporting it as its "natural" length would invent a measurement.
    const seconds = hasDuration ? duration : 0;
    if (!hasDuration) sessionsWithoutDuration += 1;

    const task = session.taskId === null ? undefined : taskById.get(session.taskId);
    if (!task) {
      // No task, or a task that no longer exists (it was deleted). Time is never
      // attributed to a task the user did not choose, so it stays unattributed.
      unattributedSeconds += seconds;
      continue;
    }

    const bucket = perTask.get(task.id) ?? {
      actualSeconds: 0,
      sessionCount: 0,
      sessionsWithoutDuration: 0,
    };
    bucket.actualSeconds += seconds;
    bucket.sessionCount += 1;
    if (!hasDuration) bucket.sessionsWithoutDuration += 1;
    perTask.set(task.id, bucket);
  }

  const rows = taskList.map((task) => {
    const bucket = perTask.get(task.id) ?? {
      actualSeconds: 0,
      sessionCount: 0,
      sessionsWithoutDuration: 0,
    };
    const plannedSeconds = task.estimatedSeconds;
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      // The plan of THIS task, even when the task is finished (a finished task
      // keeps its own plan; the plan TOTAL is what excludes it).
      plannedSeconds,
      actualSeconds: bucket.actualSeconds,
      sessionCount: bucket.sessionCount,
      sessionsWithoutDuration: bucket.sessionsWithoutDuration,
      // A task without an estimate has no variance and no verdict: "no estimate"
      // is missing data, not "on plan".
      varianceSeconds:
        plannedSeconds === null ? null : bucket.actualSeconds - plannedSeconds,
      overPlan:
        plannedSeconds === null ? null : bucket.actualSeconds > plannedSeconds,
    };
  });

  rows.sort(compareRows);

  let plannedSeconds = 0;
  let completedPlanSeconds = 0;
  let tasksWithoutEstimate = 0;
  let openTasksWithoutEstimate = 0;
  for (const task of taskList) {
    if (task.estimatedSeconds === null) {
      tasksWithoutEstimate += 1;
      // WHY this count: the PLAN is the estimate of the OPEN tasks. A finished
      // task without an estimate does not make the plan incomplete, an OPEN one
      // does — so the two are counted apart.
      if (open.has(task.status)) openTasksWithoutEstimate += 1;
      continue;
    }
    if (open.has(task.status)) plannedSeconds += task.estimatedSeconds;
    else completedPlanSeconds += task.estimatedSeconds;
  }

  const attributedSeconds = rows.reduce(
    (sum, row) => sum + row.actualSeconds,
    0
  );

  return {
    rows,
    totals: {
      // The remaining plan: the estimates of the OPEN tasks that HAVE one.
      plannedSeconds,
      // The plan of the work that is already done, reported apart so the
      // remaining plan is not inflated.
      completedPlanSeconds,
      // All the effective recorded time in scope.
      actualSeconds: attributedSeconds + unattributedSeconds,
      // The part of it that is attributed to a task.
      attributedSeconds,
      // Recorded time with no task (or with a task that no longer exists).
      unattributedSeconds,
      tasksWithoutEstimate,
      // The open tasks among them: the ones that make the PLAN incomplete.
      openTasksWithoutEstimate,
      sessionsWithoutDuration,
      tasksInScope: taskList.length,
      sessionsInScope: sessionList.length,
    },
  };
}
