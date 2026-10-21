// Central Hub — the day view.
//
// The dashboard shows one local day: the tasks due that day (the plan) and the
// sessions that start that day (the journal). A task has a due date and no clock
// time, so the plan never invents an hour. A session is placed at its effective
// start, after the latest correction. Work logs are a separate stream and are
// not read here (docs/DECISIONS.md D-007).

import { localDayKey } from "../lib/dates.js";
import { formatDurationFromSeconds } from "./logUtils.js";
import {
  ACTIVE_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  allowedNextStatuses,
} from "../features/tasks/taskUtils.js";
import { applyCorrections } from "../features/tracking/sessionUtils.js";
import { summarizePlannedVsActual } from "../features/tracking/plannedVsActual.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

const PLAN_KEYS = [
  "id",
  "title",
  "priority",
  "status",
  "estimatedSeconds",
  "dueDate",
  "isNext",
];

function read(row, camelKey, snakeKey) {
  if (!row || typeof row !== "object") return undefined;
  if (camelKey in row) return row[camelKey];
  if (snakeKey in row) return row[snakeKey];
  return undefined;
}

/**
 * A civil date, or null when the text is not a real calendar day.
 *
 * The parts are checked against the UTC date they produce, so 2026-02-31 is
 * rejected instead of rolling into March.
 */
function parseDayKey(key) {
  if (typeof key !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function formatDayKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Moves a civil date by a number of days.
 *
 * Arithmetic runs on the UTC calendar date, so a daylight-saving change cannot
 * skip or repeat a day.
 */
export function addDays(key, days) {
  const parts = parseDayKey(key);
  if (!parts || !Number.isFinite(days)) return null;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatDayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Monday-first index of a civil date (0 = Monday … 6 = Sunday).
 */
function weekdayIndex(key) {
  const parts = parseDayKey(key);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return (date.getUTCDay() + 6) % 7;
}

/**
 * The Monday–Sunday week that contains a civil date.
 *
 * @param {string} dayKey 'YYYY-MM-DD'
 * @returns {{startKey: string, endKey: string, days: Array}|null}
 */
export function weekWindow(dayKey) {
  const index = weekdayIndex(dayKey);
  if (index === null) return null;
  const startKey = addDays(dayKey, -index);
  const days = WEEKDAYS.map((weekday, offset) => {
    const key = addDays(startKey, offset);
    return {
      key,
      weekday,
      dayNumber: Number(key.slice(8)),
    };
  });
  return { startKey, endKey: days[6].key, days };
}

/**
 * The calendar day of an instant in an IANA timezone.
 */
export function todayKey(timeZone, now = new Date()) {
  return localDayKey(now, timeZone);
}

/**
 * Morning before 12:00, afternoon before 17:00, otherwise evening, in the
 * given timezone.
 */
export function greetingFor(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  if (!Number.isFinite(hour)) return "Hello";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

/**
 * The signed-in person's name.
 *
 * The profile name wins. Otherwise the part of the email before @. An account
 * with neither contributes no name — a placeholder person is not invented.
 */
export function personName(user) {
  const full =
    typeof user?.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name.trim()
      : "";
  if (full) return full;
  const email = typeof user?.email === "string" ? user.email.trim() : "";
  const local = email.split("@")[0]?.trim() ?? "";
  return local;
}

/**
 * A long date for a civil day. The weekday belongs to the calendar date, so
 * the formatting instant is noon UTC of that date and does not shift a day.
 */
export function formatDayHeading(dayKey) {
  const parts = parseDayKey(dayKey);
  if (!parts) return "";
  const noon = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(noon);
}

/**
 * The UTC instant for a civil date and clock time in an IANA timezone.
 *
 * "09:00" on a day means 09:00 in that zone, including across a daylight-saving
 * change. An unreadable date or time returns null instead of a guessed instant.
 *
 * @param {string} dayKey 'YYYY-MM-DD'
 * @param {string} time 'HH:MM' in 24-hour form
 * @param {string} timeZone
 * @returns {string|null} ISO timestamp
 */
export function civilToInstant(dayKey, time, timeZone) {
  if (!parseDayKey(dayKey) || !/^\d{2}:\d{2}$/.test(time ?? "")) return null;
  let utc = Date.parse(`${dayKey}T${time}:00Z`);
  if (!Number.isFinite(utc)) return null;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(utc));
    const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
    const hour = read("hour").padStart(2, "0");
    const minute = read("minute").padStart(2, "0");
    const seen = Date.parse(`${read("year")}-${read("month")}-${read("day")}T${hour}:${minute}:00Z`);
    const wanted = Date.parse(`${dayKey}T${time}:00Z`);
    if (!Number.isFinite(seen) || !Number.isFinite(wanted)) return null;
    if (seen === wanted) return new Date(utc).toISOString();
    utc += wanted - seen;
  }
  return new Date(utc).toISOString();
}

/**
 * A clock time for an instant in the view's timezone, or null when the
 * instant cannot be read. Null is "no time", never a made-up hour.
 */
export function formatClock(value, timeZone) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function dueDay(task) {
  const value = read(task, "dueDate", "due_date");
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

function estimatedSeconds(task) {
  const value =
    read(task, "estimatedSeconds", "estimated_duration_seconds") ??
    read(task, "estimatedDurationSeconds", "estimated_duration_seconds");
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toSession(row) {
  const duration = read(row, "durationSeconds", "duration_seconds");
  const taskId = read(row, "taskId", "task_id");
  return {
    ...row,
    id: row?.id ?? null,
    startedAt: read(row, "startedAt", "started_at") ?? null,
    endedAt: read(row, "endedAt", "ended_at") ?? null,
    durationSeconds:
      duration === null || duration === undefined || duration === ""
        ? null
        : Number(duration),
    taskId: taskId === null || taskId === undefined || taskId === "" ? null : taskId,
  };
}

function correctionsBySession(corrections) {
  const grouped = new Map();
  for (const correction of corrections ?? []) {
    const sessionId = read(correction, "sessionId", "session_id");
    if (sessionId === null || sessionId === undefined) continue;
    const list = grouped.get(sessionId) ?? [];
    list.push(correction);
    grouped.set(sessionId, list);
  }
  return grouped;
}

function effectiveOf(row, grouped) {
  const session = toSession(row);
  return applyCorrections(session, grouped.get(session.id) ?? []);
}

function recordedSeconds(effective) {
  const value = effective?.durationSeconds;
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function dayInRange(key, startKey, endKey) {
  return Boolean(key) && key >= startKey && key <= endKey;
}

function taskTitleById(tasks) {
  const titles = new Map();
  for (const task of tasks ?? []) {
    if (task?.id === null || task?.id === undefined) continue;
    titles.set(task.id, task.title ?? "");
  }
  return titles;
}

function comparePlan(a, b) {
  const aOpen = ACTIVE_STATUSES.includes(a.status) ? 0 : 1;
  const bOpen = ACTIVE_STATUSES.includes(b.status) ? 0 : 1;
  if (aOpen !== bOpen) return aOpen - bOpen;
  const aRank = PRIORITY_RANK[a.priority] ?? 4;
  const bRank = PRIORITY_RANK[b.priority] ?? 4;
  if (aRank !== bRank) return aRank - bRank;
  const byTitle = String(a.title).localeCompare(String(b.title));
  if (byTitle !== 0) return byTitle;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Tasks due on one civil day.
 *
 * Each item carries the due date and no start time. `isNext` marks the first
 * open task in queue order (open work, then priority, then title). That is a
 * position in the list, not a claim that the task starts at a particular hour.
 */
export function tasksForDay(tasks, dayKey) {
  const items = [];
  for (const task of tasks ?? []) {
    if (dueDay(task) !== dayKey) continue;
    const item = {
      id: task.id,
      title: task.title ?? "",
      priority: task.priority ?? "medium",
      status: task.status ?? "todo",
      estimatedSeconds: estimatedSeconds(task),
      dueDate: dayKey,
      isNext: false,
    };
    items.push(item);
  }
  items.sort(comparePlan);
  const next = items.find((item) => ACTIVE_STATUSES.includes(item.status));
  if (next) next.isNext = true;
  return items;
}

function toQueueItem(task) {
  return {
    id: task.id,
    title: read(task, "title", "title") ?? "",
    priority: read(task, "priority", "priority") ?? "medium",
    status: read(task, "status", "status") ?? "todo",
    estimatedSeconds: estimatedSeconds(task),
    dueDate: dueDay(task),
    isNext: false,
  };
}

/**
 * Open work in queue order: active status, then priority, then title.
 *
 * The first item is next. A finished or cancelled task is not waiting, so it
 * is left out. The order is a position in the list, not a start time.
 */
export function workQueue(tasks) {
  const items = [];
  for (const task of tasks ?? []) {
    const item = toQueueItem(task);
    if (!ACTIVE_STATUSES.includes(item.status)) continue;
    items.push(item);
  }
  items.sort(comparePlan);
  if (items[0]) items[0].isNext = true;
  return items;
}

/**
 * Tasks that have a due date, soonest day first, then queue order within a day.
 *
 * A task with no due date is not on the plan. The first open item is next.
 */
export function plannedTasks(tasks) {
  const items = [];
  for (const task of tasks ?? []) {
    const item = toQueueItem(task);
    if (!item.dueDate) continue;
    items.push(item);
  }
  items.sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    return comparePlan(a, b);
  });
  const next = items.find((item) => ACTIVE_STATUSES.includes(item.status));
  if (next) next.isNext = true;
  return items;
}

/**
 * The one forward action the day view may offer for a task.
 *
 * Complete is offered only when the state machine allows it. A todo task can
 * be started. A completed task can be reopened. Anything else the machine
 * forbids is not given a control.
 */
export function primaryAction(status) {
  const next = allowedNextStatuses(status);
  if (next.includes("completed")) return { status: "completed", label: "Complete" };
  if (status === "todo" && next.includes("in_progress")) {
    return { status: "in_progress", label: "Start" };
  }
  if (status === "completed" && next.includes("todo")) {
    return { status: "todo", label: "Reopen" };
  }
  if (status === "blocked" && next.includes("in_progress")) {
    return { status: "in_progress", label: "Resume" };
  }
  if (status === "cancelled" && next.includes("todo")) {
    return { status: "todo", label: "Reactivate" };
  }
  return null;
}

/**
 * Sessions whose effective start falls on one civil day, earliest first.
 *
 * A session with no task, or a task that is not in the loaded list, is
 * unattributed. A missing duration stays null.
 */
export function sessionsForDay({
  sessions = [],
  corrections = [],
  tasks = [],
  dayKey,
  timeZone,
} = {}) {
  const grouped = correctionsBySession(corrections);
  const titles = taskTitleById(tasks);
  const items = [];
  for (const row of sessions ?? []) {
    const effective = effectiveOf(row, grouped);
    const key = localDayKey(effective.startedAt, timeZone);
    if (key !== dayKey) continue;
    const known = effective.taskId !== null && titles.has(effective.taskId);
    items.push({
      id: effective.id,
      startedAt: effective.startedAt,
      taskTitle: known ? titles.get(effective.taskId) : null,
      durationSeconds: recordedSeconds(effective),
      unattributed: !known,
    });
  }
  items.sort((a, b) => {
    const aTime = Date.parse(a.startedAt);
    const bTime = Date.parse(b.startedAt);
    if (aTime !== bTime) return aTime - bTime;
    return String(a.id).localeCompare(String(b.id));
  });
  return items;
}

function sessionsInRange({ sessions, corrections, timeZone, startKey, endKey }) {
  const grouped = correctionsBySession(corrections);
  const chosen = [];
  for (const row of sessions ?? []) {
    const effective = effectiveOf(row, grouped);
    const key = localDayKey(effective.startedAt, timeZone);
    if (dayInRange(key, startKey, endKey)) chosen.push(row);
  }
  return chosen;
}

function tasksInRange(tasks, startKey, endKey) {
  return (tasks ?? []).filter((task) => dayInRange(dueDay(task), startKey, endKey));
}

/**
 * A short label for a day that has a due task, a recorded session, or both.
 * A day with neither has no label — it is not marked as zero.
 */
export function dayMarkLabel({ hasTask, hasSession }) {
  if (hasTask && hasSession) return "Plan and recorded";
  if (hasTask) return "Plan";
  if (hasSession) return "Recorded";
  return null;
}

/**
 * The newest in-app notification that has not been acknowledged.
 *
 * A missing list is no reminder. The function does not invent a title.
 */
export function pickReminder(notifications) {
  const open = (notifications ?? []).filter((notification) => {
    if (!notification || notification.channel !== "in_app") return false;
    return notification.status !== "acknowledged";
  });
  open.sort((a, b) => {
    const aTime = Date.parse(a.created_at ?? a.createdAt ?? "");
    const bTime = Date.parse(b.created_at ?? b.createdAt ?? "");
    const aKnown = Number.isFinite(aTime);
    const bKnown = Number.isFinite(bTime);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    if (aTime !== bTime) return bTime - aTime;
    return String(b.id).localeCompare(String(a.id));
  });
  return open[0] ?? null;
}

/**
 * The plan, the journal, the week marks and the week comparison for one day.
 *
 * @param {object} input
 * @param {string} input.dayKey the selected civil day
 * @param {string} input.timeZone IANA zone used for every session day boundary
 */
export function buildDayView({
  dayKey,
  timeZone,
  tasks = [],
  sessions = [],
  corrections = [],
  notifications = [],
} = {}) {
  const week = weekWindow(dayKey);
  if (!week) {
    return {
      week: null,
      plan: [],
      journal: [],
      marks: [],
      summary: summarizePlannedVsActual({}),
      reminder: pickReminder(notifications),
    };
  }

  const plan = tasksForDay(tasks, dayKey);
  const journal = sessionsForDay({
    sessions,
    corrections,
    tasks,
    dayKey,
    timeZone,
  });
  const weekTasks = tasksInRange(tasks, week.startKey, week.endKey);
  const weekSessions = sessionsInRange({
    sessions,
    corrections,
    timeZone,
    startKey: week.startKey,
    endKey: week.endKey,
  });
  const summary = summarizePlannedVsActual({
    tasks: weekTasks,
    sessions: weekSessions,
    corrections,
  });

  const grouped = correctionsBySession(corrections);
  const sessionDays = new Set();
  for (const row of sessions ?? []) {
    const key = localDayKey(effectiveOf(row, grouped).startedAt, timeZone);
    if (key) sessionDays.add(key);
  }
  const taskDays = new Set();
  for (const task of tasks ?? []) {
    const key = dueDay(task);
    if (key) taskDays.add(key);
  }
  const marks = week.days.map((day) => {
    const hasTask = taskDays.has(day.key);
    const hasSession = sessionDays.has(day.key);
    return {
      ...day,
      hasTask,
      hasSession,
      label: dayMarkLabel({ hasTask, hasSession }),
    };
  });

  return {
    week,
    plan,
    journal,
    marks,
    summary,
    reminder: pickReminder(notifications),
  };
}

const STATUS_LABELS = new Map(TASK_STATUSES.map((status) => [status.value, status.label]));
const PRIORITY_LABELS = new Map(
  TASK_PRIORITIES.map((priority) => [priority.value, priority.label])
);

export function statusLabel(status) {
  if (!status) return "Unknown status";
  return STATUS_LABELS.get(status) ?? String(status);
}

export function priorityLabel(priority) {
  if (!priority) return "Unknown priority";
  return PRIORITY_LABELS.get(priority) ?? String(priority);
}

export function estimateText(seconds) {
  if (seconds === null || seconds === undefined) return "No estimate";
  return formatDurationFromSeconds(seconds);
}

export function durationText(seconds) {
  if (seconds === null || seconds === undefined) return "No time recorded";
  return formatDurationFromSeconds(seconds);
}

/**
 * The planned total for the week, or the reason it cannot be shown.
 * A week with no estimates is not rendered as 0 seconds.
 */
export function plannedTotalText(totals) {
  if (!totals || totals.tasksInScope === 0) return "No tasks yet";
  if (totals.plannedSeconds === 0 && totals.openTasksWithoutEstimate > 0) {
    return "No plan recorded";
  }
  return formatDurationFromSeconds(totals.plannedSeconds);
}

/**
 * The recorded total for the week, or the reason it cannot be shown.
 * Sessions with no duration do not become a zero total.
 */
export function recordedTotalText(totals) {
  if (!totals || totals.sessionsInScope === 0) return "Nothing recorded yet";
  if (totals.actualSeconds === 0 && totals.sessionsWithoutDuration > 0) {
    return "No recorded time";
  }
  return formatDurationFromSeconds(totals.actualSeconds);
}

/**
 * The week difference, refused when either side is incomplete.
 */
export function differenceText(totals) {
  if (!totals || totals.sessionsInScope === 0) return "No recorded time to compare yet";
  if (totals.sessionsWithoutDuration > 0) {
    return "Not comparable — the recorded time is incomplete";
  }
  if (totals.openTasksWithoutEstimate > 0) {
    return "Not comparable — the plan is incomplete";
  }
  if (totals.plannedSeconds === 0) return "No plan to compare yet";
  const difference = totals.actualSeconds - totals.plannedSeconds;
  if (difference > 0) return `over by ${formatDurationFromSeconds(difference)}`;
  if (difference < 0) return `under by ${formatDurationFromSeconds(-difference)}`;
  return "on plan";
}

/** The fields a plan item is allowed to carry. Used to keep a clock off the plan. */
export const PLAN_ITEM_KEYS = PLAN_KEYS;
