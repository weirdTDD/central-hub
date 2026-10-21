// Links this week's tasks to the sessions recorded against them.
//
// Career path and learning have no records in the database. Those branches stay
// empty and say so. A missing duration is missing, never zero. A weak spot is a
// real gap in a record that exists: overdue, blocked, open work with no recorded
// time, activity with no task, or a session with no duration.

import { localDayKey } from "../../lib/dates.js";
import { applyCorrections } from "./sessionUtils.js";

const CLOSED = new Set(["completed", "cancelled"]);

/**
 * Monday–Sunday range containing `today`, as local day keys.
 *
 * @param {Date} [today]
 * @returns {{startKey: string, endKey: string, todayKey: string}}
 */
export function weekRange(today = new Date()) {
  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + mondayOffset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return {
    startKey: localDayKey(start),
    endKey: localDayKey(end),
    todayKey: localDayKey(today),
  };
}

function inRange(key, startKey, endKey) {
  return typeof key === "string" && key >= startKey && key <= endKey;
}

function correctionsFor(corrections, sessionId) {
  return (corrections ?? []).filter(
    (row) => (row.session_id ?? row.sessionId) === sessionId
  );
}

/**
 * @param {object} input
 * @param {Array} input.tasks
 * @param {Array} input.sessions
 * @param {Array} [input.corrections]
 * @param {Date} [input.today]
 */
export function buildProgressTree({ tasks = [], sessions = [], corrections = [], today = new Date() } = {}) {
  const week = weekRange(today);
  const effective = (sessions ?? []).map((session) =>
    applyCorrections(session, correctionsFor(corrections, session.id))
  );

  const weeklyTasks = (tasks ?? []).filter((task) => {
    const due = task.dueDate ?? task.due_date ?? null;
    const completed = localDayKey(task.completedAt ?? task.completed_at ?? null);
    const open = !CLOSED.has(task.status);
    const slipped = open && typeof due === "string" && due < week.startKey;
    return inRange(due, week.startKey, week.endKey) || inRange(completed, week.startKey, week.endKey) || slipped;
  });

  const weeklyIds = new Set(weeklyTasks.map((task) => task.id));
  const byTask = new Map(weeklyTasks.map((task) => [task.id, []]));
  const unlinked = [];

  for (const session of effective) {
    const day = localDayKey(session.startedAt);
    if (session.taskId && weeklyIds.has(session.taskId)) {
      byTask.get(session.taskId).push(session);
    } else if (!session.taskId && inRange(day, week.startKey, week.endKey)) {
      unlinked.push(session);
    }
  }

  const weakSpots = [];
  const taskNodes = weeklyTasks.map((task) => {
    const linked = byTask.get(task.id) ?? [];
    const due = task.dueDate ?? task.due_date ?? null;
    const open = !CLOSED.has(task.status);
    const reasons = [];
    if (open && typeof due === "string" && due < week.todayKey) reasons.push("Overdue");
    if (task.status === "blocked") reasons.push("Blocked");
    const recorded = linked.some(
      (session) => session.durationSeconds !== null && session.durationSeconds !== undefined
    );
    if (open && !recorded) reasons.push("No recorded time");

    for (const reason of reasons) {
      weakSpots.push({ id: `${task.id}:${reason}`, title: task.title || "Untitled task", reason });
    }

    return {
      id: task.id,
      kind: "task",
      title: task.title || "Untitled task",
      detail: task.status || "No status",
      weak: reasons.length > 0,
      weakReason: reasons.join(" · ") || null,
      children: linked.map((session) => {
        const missing = session.durationSeconds === null || session.durationSeconds === undefined;
        if (missing) {
          weakSpots.push({
            id: `${session.id}:duration`,
            title: task.title || "Untitled task",
            reason: "Session has no duration",
          });
        }
        return {
          id: session.id,
          kind: "session",
          title: missing ? "No data" : "Recorded time",
          detail: session.application || session.source || "Session",
          durationSeconds: missing ? null : session.durationSeconds,
          weak: missing,
          weakReason: missing ? "No duration" : null,
          children: [],
        };
      }),
    };
  });

  for (const session of unlinked) {
    const missing = session.durationSeconds === null || session.durationSeconds === undefined;
    weakSpots.push({
      id: `${session.id}:unlinked`,
      title: session.application || "Unlinked activity",
      reason: "Not linked to a goal",
    });
    if (missing) {
      weakSpots.push({
        id: `${session.id}:duration`,
        title: session.application || "Unlinked activity",
        reason: "Session has no duration",
      });
    }
  }

  const unlinkedNode =
    unlinked.length === 0
      ? null
      : {
          id: "unlinked",
          kind: "gap",
          title: "Not linked",
          detail: `${unlinked.length} ${unlinked.length === 1 ? "session" : "sessions"} this week with no task`,
          weak: true,
          weakReason: "Not linked to a goal",
          children: unlinked.map((session) => ({
            id: session.id,
            kind: "session",
            title: session.application || session.source || "Session",
            detail: "No task",
            durationSeconds:
              session.durationSeconds === null || session.durationSeconds === undefined
                ? null
                : session.durationSeconds,
            weak: true,
            weakReason: "Not linked to a goal",
            children: [],
          })),
        };

  return {
    week,
    weakSpots,
    branches: [
      {
        id: "weekly",
        title: "Weekly goals",
        state: taskNodes.length === 0 && !unlinkedNode ? "empty" : "data",
        detail:
          taskNodes.length === 0
            ? "No task is due, overdue, or completed this week."
            : `${taskNodes.length} ${taskNodes.length === 1 ? "task" : "tasks"} linked to recorded time.`,
        children: unlinkedNode ? [...taskNodes, unlinkedNode] : taskNodes,
      },
      {
        id: "career",
        title: "Career path",
        state: "no-data",
        detail: "No career records yet. Nothing here is a score of zero.",
        children: [],
      },
      {
        id: "learning",
        title: "Learning",
        state: "no-data",
        detail: "No learning activity is recorded. No learning platform is connected.",
        children: [],
      },
    ],
  };
}
