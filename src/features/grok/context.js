// Central Hub — the records Grok may see, and only when a tool asks for them.
//
// The snapshot is built from rows the caller already loaded for the signed-in
// user. It does not fetch anything. Coding time, learning time, sessions, and
// work logs stay separate: the note in the snapshot says not to add them.
// A missing measurement stays null. File names, page addresses, window titles,
// and the account email are not included.

import { coveredSeconds as coveredCodingSeconds, groupedCoveredSeconds as groupedCodingSeconds } from "../../../extensions/coding-tracker/lib/codingTime.js";
import { coveredSeconds as coveredLearningSeconds, groupedCoveredSeconds as groupedLearningSeconds } from "../../../extensions/learning-tracker/lib/learningTime.js";
import { timezoneParts, wallClockToInstant } from "../notifications/workflowEngine.js";
import { ACTIVE_STATUSES } from "../tasks/taskUtils.js";

export const CONTEXT_RANGES = ["today", "this_week", "last_7_days", "last_30_days"];

export const CONTEXT_FOCUSES = ["tasks", "work_logs", "coding", "learning", "alerts"];

const OPEN = new Set(ACTIVE_STATUSES);

/**
 * The bounds a context question is about.
 *
 * `today` and `this_week` follow the timezone. This week starts on Monday.
 * `to` is exclusive.
 *
 * @param {string} range
 * @param {Date|string|number} now
 * @param {string} timeZone
 * @returns {{id: string, label: string, from: Date, to: Date}}
 */
export function rangeBounds(range, now, timeZone) {
  const instant = now instanceof Date ? now : new Date(now);
  const zone = timeZone || "UTC";
  const parts = timezoneParts(instant, zone);
  const id = CONTEXT_RANGES.includes(range) ? range : "this_week";

  if (id === "today") {
    const from = wallClockToInstant({ ...parts, hour: 0, minute: 0 }, zone);
    const to = wallClockToInstant(shiftCivilDate(parts, 1), zone);
    return { id, label: "today", from, to };
  }

  if (id === "this_week") {
    const delta = parts.weekday === 0 ? 6 : parts.weekday - 1;
    const monday = shiftCivilDate(parts, -delta);
    const from = wallClockToInstant({ ...monday, hour: 0, minute: 0 }, zone);
    const to = wallClockToInstant(shiftCivilDate(monday, 7), zone);
    return { id, label: "this week, Monday to Sunday", from, to };
  }

  const days = id === "last_30_days" ? 30 : 7;
  return {
    id,
    label: `the last ${days} days`,
    from: new Date(instant.getTime() - days * 24 * 60 * 60 * 1000),
    to: instant,
  };
}

/**
 * A compact snapshot of the owner's own records.
 *
 * @param {object} input
 * @returns {object}
 */
export function buildOwnerContext({
  tasks = [],
  workLogs = [],
  coding = [],
  learning = [],
  sessions = [],
  alerts = [],
  now = new Date(),
  timeZone = "UTC",
  range = "this_week",
  focus = [],
} = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  const zone = timeZone || "UTC";
  const bounds = rangeBounds(range, instant, zone);
  const wanted = normalizeFocus(focus);
  const todayKey = localDateKey(instant, zone);

  const snapshot = {
    range: {
      id: bounds.id,
      label: bounds.label,
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
      timeZone: zone,
    },
    note:
      "activeSeconds and durationSeconds are whole seconds. null means nothing was measured, not zero. Coding time, learning time, recorded sessions, and work logs are separate. Do not add them together. Do not treat time spent as achievement.",
  };

  if (wanted.has("tasks")) {
    const open = (tasks ?? []).filter((task) => OPEN.has(task?.status));
    const sessionTaskIds = new Set(
      (sessions ?? [])
        .filter((session) => inInstantRange(session?.started_at ?? session?.startedAt, bounds))
        .map((session) => session?.task_id ?? session?.taskId)
        .filter(Boolean)
    );

    snapshot.tasks = {
      openCount: open.length,
      open: open.slice(0, 40).map((task) => ({
        id: task.id,
        title: task.title ?? "",
        status: task.status,
        priority: task.priority ?? null,
        dueDate: task.due_date ?? task.dueDate ?? null,
        estimatedSeconds: numberOrNull(task.estimated_duration_seconds ?? task.estimatedSeconds),
        overdue: isOverdue(task, todayKey),
      })),
      omitted: Math.max(0, open.length - 40),
    };

    snapshot.neglect = open
      .filter((task) => isOverdue(task, todayKey) || !sessionTaskIds.has(task.id))
      .slice(0, 20)
      .map((task) => ({
        id: task.id,
        title: task.title ?? "",
        dueDate: task.due_date ?? task.dueDate ?? null,
        status: task.status,
        reason: isOverdue(task, todayKey)
          ? "past due"
          : "no recorded session in this range",
      }));
  }

  if (wanted.has("work_logs")) {
    const logs = (workLogs ?? []).filter((log) =>
      logInRange(log?.log_date ?? log?.logDate, bounds, zone)
    );
    const measured = logs.filter((log) => numberOrNull(log?.duration_seconds ?? log?.durationSeconds) != null);
    const total = measured.reduce(
      (sum, log) => sum + numberOrNull(log.duration_seconds ?? log.durationSeconds),
      0
    );
    snapshot.workLogs = {
      count: logs.length,
      withDuration: measured.length,
      missingDuration: logs.length - measured.length,
      durationSeconds: measured.length > 0 ? total : null,
      recent: logs.slice(0, 15).map((log) => ({
        title: log.title ?? "",
        logDate: log.log_date ?? log.logDate ?? null,
        durationSeconds: numberOrNull(log.duration_seconds ?? log.durationSeconds),
        notes: clip(log.notes, 180),
      })),
    };
  }

  if (wanted.has("coding")) {
    const beats = (coding ?? []).filter((beat) =>
      inInstantRange(beat?.occurred_at ?? beat?.occurredAt, bounds)
    );
    snapshot.coding = {
      activeSeconds: coveredCodingSeconds(beats),
      heartbeatCount: beats.length,
      byProject: groupedCodingSeconds(
        beats,
        (beat) => beat.projectName || "Unknown project"
      )
        .slice(0, 8)
        .map((group) => ({
          project: group.key,
          activeSeconds: group.activeSeconds,
          heartbeatCount: group.heartbeatCount,
        })),
    };
  }

  if (wanted.has("learning")) {
    const beats = (learning ?? []).filter((beat) =>
      inInstantRange(beat?.occurred_at ?? beat?.occurredAt, bounds)
    );
    snapshot.learning = {
      activeSeconds: coveredLearningSeconds(beats),
      heartbeatCount: beats.length,
      byCourse: groupedLearningSeconds(beats, learningKey)
        .slice(0, 8)
        .map((group) => ({
          course: group.key,
          activeSeconds: group.activeSeconds,
          heartbeatCount: group.heartbeatCount,
        })),
    };
  }

  if (wanted.has("alerts")) {
    const rows = (alerts ?? []).filter((alert) => alert?.status === "scheduled" || alert?.status === "paused");
    snapshot.alerts = rows.slice(0, 30).map((alert) => ({
      id: alert.id,
      taskId: alert.task_id ?? alert.taskId ?? null,
      title: alert.title ?? "",
      dueAt: alert.due_at ?? alert.dueAt ?? null,
      repeat: alert.repeat ?? "none",
      status: alert.status,
    }));
  }

  return snapshot;
}

/**
 * @param {Array<string>|string|undefined} focus
 * @returns {Set<string>}
 */
function normalizeFocus(focus) {
  const list = Array.isArray(focus) ? focus : typeof focus === "string" && focus ? [focus] : [];
  const known = list.filter((item) => CONTEXT_FOCUSES.includes(item));
  if (known.length === 0) return new Set(CONTEXT_FOCUSES);
  return new Set(known);
}

/**
 * @param {object} task
 * @param {string|null} todayKey
 */
function isOverdue(task, todayKey) {
  const due = task?.due_date ?? task?.dueDate;
  return typeof due === "string" && todayKey != null && due < todayKey;
}

/**
 * @param {unknown} value
 * @param {{from: Date, to: Date}} bounds
 */
function inInstantRange(value, bounds) {
  if (value == null || value === "") return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  return time >= bounds.from.getTime() && time < bounds.to.getTime();
}

/**
 * A work log is included when its local day overlaps the range.
 *
 * @param {unknown} logDate YYYY-MM-DD
 * @param {{from: Date, to: Date}} bounds
 * @param {string} timeZone
 */
function logInRange(logDate, bounds, timeZone) {
  if (typeof logDate !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(logDate);
  if (!match) return false;
  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
  const start = wallClockToInstant(wall, timeZone);
  const end = wallClockToInstant(shiftCivilDate(wall, 1), timeZone);
  return end.getTime() > bounds.from.getTime() && start.getTime() < bounds.to.getTime();
}

/**
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {string|null}
 */
function localDateKey(instant, timeZone) {
  const parts = timezoneParts(instant, timeZone);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/**
 * @param {object} wall
 * @param {number} days
 */
function shiftCivilDate(wall, days) {
  const utc = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: 0,
    minute: 0,
  };
}

/**
 * @param {object} beat a normalised learning heartbeat
 */
function learningKey(beat) {
  const site = beat.siteHost || "Unknown site";
  return beat.courseLabel ? `${site} · ${beat.courseLabel}` : site;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string|null}
 */
function clip(value, limit) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
