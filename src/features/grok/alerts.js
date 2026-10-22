// Central Hub — task reminders.
//
// A reminder points at one task the owner already has, fires at a due instant,
// and optionally repeats. The row is the schedule. Opening the app is what
// delivers it: a closed laptop cannot show a notification, and a missed repeat
// is not replayed as a stack of old ones. The next future occurrence is kept,
// and one notification is written for the occurrence that came due.
//
// Delivery reuses the in-app notifications table. The browser notification is
// this device showing that same row. It is not a second channel in the database.
//
// This module is pure. The page, the alert runner, and the Grok tool all use it.

import { deterministicUuid } from "../../lib/stableId.js";
import {
  applyQuietHours,
  timezoneParts,
  wallClockToInstant,
} from "../notifications/workflowEngine.js";

/** How a reminder repeats. `none` fires once. */
export const REPEAT_RULES = ["none", "daily", "weekly", "weekdays"];

export const REPEAT_LABELS = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week",
  weekdays: "Weekdays",
};

/** Statuses a person can set. `fired` is written by delivery, not by the form. */
export const ALERT_STATUSES = ["scheduled", "paused", "fired"];

const TITLE_LIMIT = 200;
const NOTE_LIMIT = 500;

/** A new reminder may be this far in the past and still count as "now". */
const PAST_TOLERANCE_MS = 60_000;

/**
 * The inbox row for one occurrence of one reminder.
 *
 * The same occurrence always produces the same id, so opening the app twice
 * does not write two notifications.
 *
 * @param {string} alertId
 * @param {string} occurrence ISO instant of the due time that fired
 * @returns {string}
 */
export function alertNotificationId(alertId, occurrence) {
  return deterministicUuid(`task-alert|${alertId}|${occurrence}`);
}

/**
 * Collapses whitespace. A non-string is empty.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function collapseText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * A `datetime-local` value in a timezone, as an ISO instant.
 *
 * The value has no offset. The timezone says what clock the person meant.
 *
 * @param {unknown} value "YYYY-MM-DDTHH:MM"
 * @param {string} timeZone
 * @returns {string|null}
 */
export function localDateTimeToIso(value, timeZone) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const wall = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31) return null;
  if (wall.hour > 23 || wall.minute > 59) return null;
  const instant = wallClockToInstant(wall, timeZone || "UTC");
  if (!Number.isFinite(instant.getTime())) return null;
  return instant.toISOString();
}

/**
 * The wall-clock value to show in a `datetime-local` input.
 *
 * @param {string|Date|number} instant
 * @param {string} timeZone
 * @returns {string}
 */
export function isoToLocalDateTime(instant, timeZone) {
  const parts = timezoneParts(instant, timeZone || "UTC");
  if (!parts) return "";
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const hour = String(parts.hour).padStart(2, "0");
  const minute = String(parts.minute).padStart(2, "0");
  return `${parts.year}-${month}-${day}T${hour}:${minute}`;
}

/**
 * Checks a new reminder before it is stored.
 *
 * @param {object} input
 * @param {{now?: Date|string|number, timeZone?: string}} [options]
 * @returns {{ok: true, value: object, error: null}|{ok: false, value: null, error: string}}
 */
export function validateAlertDraft(input, options = {}) {
  const now = toDate(options.now) ?? new Date();
  const timeZone = options.timeZone || "UTC";
  const taskId = typeof input?.taskId === "string" ? input.taskId.trim() : "";
  if (!taskId) {
    return { ok: false, value: null, error: "Choose a task for this reminder." };
  }

  const due = toDate(input?.dueAt);
  if (!due) {
    return { ok: false, value: null, error: "The due time is not a valid time." };
  }
  if (due.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    return { ok: false, value: null, error: "The due time is in the past." };
  }

  const repeat = input?.repeat ?? "none";
  if (!REPEAT_RULES.includes(repeat)) {
    return {
      ok: false,
      value: null,
      error: "Repeat must be none, daily, weekly, or weekdays.",
    };
  }

  const fallback = collapseText(input?.taskTitle);
  const title = collapseText(input?.title) || (fallback ? `Reminder: ${fallback}` : "");
  if (!title) {
    return { ok: false, value: null, error: "The reminder needs a title." };
  }
  if (title.length > TITLE_LIMIT) {
    return { ok: false, value: null, error: "The reminder title is too long." };
  }

  const note = input?.note == null || input.note === "" ? null : collapseText(input.note);
  if (note && note.length > NOTE_LIMIT) {
    return { ok: false, value: null, error: "The note is too long." };
  }

  const createdBy = input?.createdBy === "grok" ? "grok" : "user";

  return {
    ok: true,
    error: null,
    value: {
      taskId,
      title,
      note,
      dueAt: due.toISOString(),
      repeat,
      timezone: timeZone,
      createdBy,
    },
  };
}

/**
 * Checks a change to an existing reminder.
 *
 * @param {object} input
 * @param {{now?: Date|string|number, timeZone?: string}} [options]
 * @returns {{ok: true, value: object, error: null}|{ok: false, value: null, error: string}}
 */
export function validateAlertPatch(input, options = {}) {
  const now = toDate(options.now) ?? new Date();
  const patch = {};

  if (input?.dueAt != null && input.dueAt !== "") {
    const due = toDate(input.dueAt);
    if (!due) return { ok: false, value: null, error: "The due time is not a valid time." };
    if (due.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
      return { ok: false, value: null, error: "The due time is in the past." };
    }
    patch.dueAt = due.toISOString();
  }

  if (input?.title != null) {
    const title = collapseText(input.title);
    if (!title) return { ok: false, value: null, error: "The reminder needs a title." };
    if (title.length > TITLE_LIMIT) {
      return { ok: false, value: null, error: "The reminder title is too long." };
    }
    patch.title = title;
  }

  if ("note" in (input ?? {})) {
    const note = input.note == null || input.note === "" ? null : collapseText(input.note);
    if (note && note.length > NOTE_LIMIT) {
      return { ok: false, value: null, error: "The note is too long." };
    }
    patch.note = note;
  }

  if (input?.repeat != null) {
    if (!REPEAT_RULES.includes(input.repeat)) {
      return {
        ok: false,
        value: null,
        error: "Repeat must be none, daily, weekly, or weekdays.",
      };
    }
    patch.repeat = input.repeat;
  }

  if (input?.status != null) {
    if (input.status !== "scheduled" && input.status !== "paused") {
      return { ok: false, value: null, error: "A reminder can be scheduled or paused." };
    }
    patch.status = input.status;
  }

  if (options.timeZone && (patch.dueAt || patch.repeat)) {
    patch.timezone = options.timeZone;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, value: null, error: "Nothing to change." };
  }

  return { ok: true, value: patch, error: null };
}

/**
 * The next time a repeating reminder is due, strictly after `now`.
 *
 * Weekdays skip Saturday and Sunday in the reminder's timezone. A daily
 * reminder keeps the same clock time across a daylight-saving change.
 * Returns null for a reminder that does not repeat, or when no future
 * occurrence could be found.
 *
 * @param {string|Date|number} dueAt the occurrence that just fired
 * @param {string} repeat
 * @param {string} timeZone
 * @param {Date|string|number} now
 * @returns {string|null}
 */
export function nextDueAt(dueAt, repeat, timeZone, now) {
  if (!REPEAT_RULES.includes(repeat) || repeat === "none") return null;
  const zone = timeZone || "UTC";
  const origin = timezoneParts(dueAt, zone);
  const limit = toDate(now);
  if (!origin || !limit) return null;

  let wall = {
    year: origin.year,
    month: origin.month,
    day: origin.day,
    hour: origin.hour,
    minute: origin.minute,
  };

  for (let step = 0; step < 400; step += 1) {
    wall = shiftCivilDate(wall, repeat === "weekly" ? 7 : 1);
    if (repeat === "weekdays") wall = skipWeekend(wall, zone);
    const instant = wallClockToInstant(wall, zone);
    if (instant.getTime() > limit.getTime()) return instant.toISOString();
  }
  return null;
}

/**
 * What to do with one reminder at `now`.
 *
 * `wait` — it is not due yet.
 * `skip` — it is paused, already delivered, or not a scheduled reminder.
 * `deliver` — write one inbox notification, then advance the schedule.
 * `advance` — the owner turned task reminders off. Move the schedule on
 * without writing an inbox row, so a muted reminder does not pile up.
 *
 * @param {object} alert
 * @param {Date|string|number} now
 * @param {object|null} preferences notification_preferences row
 * @returns {object}
 */
export function planAlertDelivery(alert, now, preferences = null) {
  const instant = toDate(now) ?? new Date();
  const status = alert?.status;
  if (status === "paused") return { action: "skip", reason: "paused" };
  if (status !== "scheduled") return { action: "skip", reason: "not scheduled" };

  const due = toDate(alert.due_at ?? alert.dueAt);
  if (!due) return { action: "skip", reason: "invalid due time" };
  if (due.getTime() > instant.getTime()) return { action: "wait", reason: "not due" };

  const occurrence = due.toISOString();
  const lastFired = toDate(alert.last_fired_at ?? alert.lastFiredAt);
  if (lastFired && lastFired.getTime() >= due.getTime()) {
    return { action: "skip", reason: "already delivered" };
  }

  const repeat = REPEAT_RULES.includes(alert.repeat) ? alert.repeat : "none";
  const zone = alert.timezone || preferences?.timezone || "UTC";
  const upcoming = repeat === "none" ? null : nextDueAt(due, repeat, zone, instant);
  const continues = repeat !== "none" && upcoming != null;
  const alertUpdate = {
    status: continues ? "scheduled" : "fired",
    lastFiredAt: occurrence,
    dueAt: continues ? upcoming : occurrence,
  };

  if (preferences?.kinds?.task_alert === false) {
    return {
      action: "advance",
      reason: "task reminders are off",
      occurrence,
      notification: null,
      alertUpdate,
      browser: false,
      held: false,
    };
  }

  const quiet = applyQuietHours(instant, preferences ?? {});
  const held = quiet.deferred === true;
  const browser = !held && preferences?.channels?.browser === true;
  const alertId = alert.id;
  const taskId = alert.task_id ?? alert.taskId ?? null;

  return {
    action: "deliver",
    reason: held ? "held back by quiet hours" : "due",
    occurrence,
    browser,
    held,
    alertUpdate,
    notification: {
      id: alertNotificationId(alertId, occurrence),
      kind: "task_alert",
      channel: "in_app",
      title: alert.title || "Reminder",
      body: alert.note || alert.body || null,
      status: held ? "scheduled" : "delivered",
      scheduledFor: occurrence,
      sentAt: held ? null : instant.toISOString(),
      deliveredAt: held ? null : instant.toISOString(),
      snoozedUntil: held ? quiet.deferredTo : null,
      payload: {
        alertId,
        taskId,
        occurrence,
        repeat,
        source: "task_alert",
      },
    },
  };
}

/**
 * A task-alert notification that was held for quiet hours and can be shown now.
 *
 * @param {object} notification
 * @param {Date|string|number} now
 * @returns {object|null} the fields to write, or null when it stays held
 */
export function planHeldRelease(notification, now) {
  if (!notification || notification.kind !== "task_alert") return null;
  if (notification.status !== "scheduled") return null;
  const until = toDate(notification.snoozed_until ?? notification.snoozedUntil);
  if (!until) return null;
  const instant = toDate(now) ?? new Date();
  if (until.getTime() > instant.getTime()) return null;
  return {
    status: "delivered",
    sentAt: instant.toISOString(),
    deliveredAt: instant.toISOString(),
    snoozedUntil: null,
  };
}

/**
 * Finds the owner's task for a reminder.
 *
 * One exact title match wins. One partial title or description match wins.
 * Several matches, or none, do not pick a task.
 *
 * @param {Array<object>} tasks
 * @param {string} query
 * @returns {{ok: true, task: object, matches: object[]}|{ok: false, reason: "empty"|"none"|"many", task: null, matches: object[]}}
 */
export function matchTasks(tasks, query) {
  const wanted = collapseText(query).toLowerCase();
  const rows = Array.isArray(tasks) ? tasks : [];
  if (!wanted) return { ok: false, reason: "empty", task: null, matches: [] };

  const described = rows.map((task) => ({
    task,
    title: collapseText(task?.title).toLowerCase(),
    description: collapseText(task?.description).toLowerCase(),
  }));

  const exact = described.filter((row) => row.title === wanted);
  if (exact.length === 1) {
    return { ok: true, task: exact[0].task, matches: exact.map(toMatch) };
  }
  if (exact.length > 1) {
    return { ok: false, reason: "many", task: null, matches: exact.slice(0, 8).map(toMatch) };
  }

  const partial = described.filter(
    (row) => row.title.includes(wanted) || (row.description && row.description.includes(wanted))
  );
  if (partial.length === 1) {
    return { ok: true, task: partial[0].task, matches: partial.map(toMatch) };
  }
  return {
    ok: false,
    reason: partial.length === 0 ? "none" : "many",
    task: null,
    matches: partial.slice(0, 8).map(toMatch),
  };
}

/**
 * Delivers every due reminder.
 *
 * A notification is written before the reminder moves forward. Repeating the
 * call after a crash writes the same notification id again (a no-op) and then
 * finishes the schedule update. A browser notification is requested only when
 * this call actually inserted the inbox row.
 *
 * @param {object} input
 * @returns {Promise<Array<object>>} notifications that were newly inserted or released
 */
export async function deliverDueAlerts({
  alerts = [],
  held = [],
  now = new Date(),
  preferences = null,
  writeNotification,
  updateAlert,
  updateNotification,
  browserNotify = null,
} = {}) {
  const instant = toDate(now) ?? new Date();
  const surfaced = [];

  for (const alert of alerts) {
    const plan = planAlertDelivery(alert, instant, preferences);
    if (plan.action !== "deliver" && plan.action !== "advance") continue;

    if (plan.action === "deliver" && plan.notification) {
      const written = await writeNotification(plan.notification);
      const inserted = written?.inserted ?? 0;
      if (inserted > 0 && !plan.held) {
        surfaced.push(plan.notification);
        if (plan.browser && typeof browserNotify === "function") {
          browserNotify(plan.notification);
        }
      }
    }

    if (plan.alertUpdate && typeof updateAlert === "function") {
      await updateAlert(alert.id, plan.alertUpdate);
    }
  }

  for (const notification of held) {
    const release = planHeldRelease(notification, instant);
    if (!release || typeof updateNotification !== "function") continue;
    await updateNotification(notification.id, release);
    const shown = { ...notification, ...release };
    surfaced.push(shown);
    if (preferences?.channels?.browser === true && typeof browserNotify === "function") {
      browserNotify(shown);
    }
  }

  return surfaced;
}

/**
 * @param {{year: number, month: number, day: number, hour: number, minute: number}} wall
 * @param {number} days
 */
function shiftCivilDate(wall, days) {
  const utc = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

/**
 * Moves Saturday and Sunday forward to Monday, keeping the clock time.
 *
 * @param {object} wall
 * @param {string} zone
 */
function skipWeekend(wall, zone) {
  let current = wall;
  for (let guard = 0; guard < 7; guard += 1) {
    const weekday = timezoneParts(wallClockToInstant(current, zone), zone)?.weekday;
    if (weekday !== 0 && weekday !== 6) return current;
    current = shiftCivilDate(current, 1);
  }
  return current;
}

/**
 * @param {object} row
 */
function toMatch(row) {
  return {
    id: row.task?.id ?? null,
    title: row.task?.title ?? "",
    status: row.task?.status ?? null,
  };
}

/**
 * @param {unknown} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
