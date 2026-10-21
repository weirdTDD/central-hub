// Central Hub — the workflow engine.
//
// Serves MASTER_SPEC Section 7E: "a reliable workflow foundation with time-based
// and event-based triggers, explicit conditions and permitted actions, persistent job
// scheduling, idempotency and duplicate prevention, retry policies and execution
// history, cancellation and recovery after restart, quiet hours, snoozing, and
// delivery preferences, and approval requirements for sensitive actions".
//
// This module is deliberately PURE — no React, no network, no database, no browser
// APIs — so every rule can be verified with plain Node assertions (see
// scripts/verify-notifications.mjs) and so the worker (scripts/worker.mjs) and the
// app run exactly the same rules.
//
// The rules implemented here:
//   - WHEN a scheduled workflow is next due (timezone-aware, wall-clock based).
//   - WHICH conditions must hold before it acts (an unknown condition never matches).
//   - WHEN a notification is held back by quiet hours, and until when.
//   - HOW LONG a failed attempt waits before the next one (exponential backoff).
//   - WHICH state transitions are legal (a notification is not "delivered" before it
//     was sent, and a run is not "succeeded" before it ran).
//   - HOW a scheduled occurrence gets its duplicate-prevention key.

import { deterministicUuid, stableHash } from "../../lib/stableId.js";

/** The kinds of trigger a workflow can have. */
export const TRIGGER_TYPES = ["schedule", "event"];

/** The kinds of TIME-based trigger. */
export const TRIGGER_KINDS = ["daily", "weekly", "interval"];

/**
 * The EVENT triggers that exist.
 *
 * WHY only one: the spec asks for "time-based and event-based triggers", and a
 * trigger that is not implemented must not be offered. Every entry here is executed
 * by the worker against real rows.
 */
export const EVENT_TYPES = ["task_completed"];

/** The states of a workflow run. */
export const RUN_STATUSES = [
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "awaiting_approval",
];

/** The states of a notification — the four the spec asks to be told apart. */
export const NOTIFICATION_STATUSES = [
  "scheduled",
  "sent",
  "delivered",
  "acknowledged",
  "failed",
  "cancelled",
];

/** The states of an approval request. */
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"];

/** The delivery channels that exist. Only the in-app inbox is implemented. */
export const CHANNELS = ["in_app"];

/** The conditions a workflow can require. */
export const CONDITION_TYPES = [
  "task_overdue",
  "task_due_today",
  "unattributed_sessions",
];

/** The legal transitions of a notification. */
export const NOTIFICATION_TRANSITIONS = {
  scheduled: ["sent", "cancelled", "failed"],
  sent: ["delivered", "failed"],
  delivered: ["acknowledged"],
  acknowledged: [],
  failed: [],
  cancelled: [],
};

/** The legal transitions of a workflow run. */
export const RUN_TRANSITIONS = {
  scheduled: ["running", "cancelled", "skipped"],
  running: ["succeeded", "failed", "awaiting_approval", "cancelled"],
  awaiting_approval: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

/** The task states that mean "this task is not outstanding any more". */
const CLOSED_TASK_STATUSES = ["completed", "cancelled"];

/** The longest a retry backoff may grow to (one hour). */
export const MAX_BACKOFF_SECONDS = 3600;

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Parses a 'HH:MM' wall-clock time into minutes since midnight.
 *
 * @param {string} value
 * @returns {number|null} minutes since midnight, or null when the value is not a time
 */
export function parseClockTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Renders minutes since midnight as a 'HH:MM' wall-clock time.
 *
 * @param {number} minutes
 * @returns {string}
 */
export function formatClockTime(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/**
 * The wall-clock parts of an instant in a timezone.
 *
 * @param {Date|string|number} instant
 * @param {string} timeZone an IANA timezone
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number, weekday:number}|null}
 */
export function timezoneParts(instant, timeZone) {
  const date = toDate(instant);
  if (!date) return null;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });

    const parts = {};
    for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;

    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour) % 24,
      minute: Number(parts.minute),
      second: Number(parts.second),
      weekday: WEEKDAY_NAMES.indexOf(parts.weekday),
    };
  } catch {
    // An unknown timezone must not lose the schedule: fall back to UTC.
    return timezoneParts(date, "UTC");
  }
}

/**
 * The offset of a timezone from UTC at a given instant, in milliseconds.
 *
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {number}
 */
export function zoneOffsetMs(instant, timeZone) {
  const parts = timezoneParts(instant, timeZone);
  if (!parts) return 0;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in a timezone into the UTC instant it happens at.
 *
 * WHY two passes: the offset depends on the instant, and the instant depends on the
 * offset. The first pass guesses with the offset at the naive instant, the second
 * corrects it if the guess landed on the other side of a DST change.
 *
 * A wall-clock time that does not exist (the hour skipped by a DST change) resolves
 * to the instant the clock jumps to — it is never silently moved to the next day.
 *
 * @param {{year:number, month:number, day:number, hour:number, minute:number}} wall
 * @param {string} timeZone
 * @returns {Date}
 */
export function wallClockToInstant(wall, timeZone) {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    0
  );

  const firstOffset = zoneOffsetMs(new Date(naive), timeZone);
  let timestamp = naive - firstOffset;

  const secondOffset = zoneOffsetMs(new Date(timestamp), timeZone);
  if (secondOffset !== firstOffset) timestamp = naive - secondOffset;

  return new Date(timestamp);
}

/**
 * Parses anything date-like into a Date.
 *
 * @param {Date|string|number} value
 * @returns {Date|null}
 */
function toDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

/**
 * The next occurrence of a time-based trigger, strictly after `from`.
 *
 * The trigger is a WALL-CLOCK time in a timezone: a daily 09:00 trigger fires at
 * 09:00 local time, which is a different instant before and after a DST change.
 *
 * @param {object} config {kind, at, weekdays, everyMinutes, timezone}
 * @param {Date|string|number} from the instant to search from
 * @param {string} [timeZone] the timezone of the trigger, if not inside the config
 * @returns {string|null} the ISO instant of the next occurrence, or null when the
 *   configuration is not valid
 */
export function nextRunAt(config, from, timeZone) {
  const settings = config ?? {};
  const zone = settings.timezone ?? timeZone ?? "UTC";
  const start = toDate(from) ?? new Date();
  const kind = settings.kind;

  if (kind === "interval") {
    const minutes = Number(settings.everyMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return new Date(start.getTime() + minutes * 60_000).toISOString();
  }

  const at = parseClockTime(settings.at);
  if (at === null) return null;
  const hour = Math.floor(at / 60);
  const minute = at % 60;

  const local = timezoneParts(start, zone);
  if (!local) return null;

  if (kind === "daily") {
    const today = wallClockToInstant(
      { ...local, hour, minute },
      zone
    );
    if (today.getTime() > start.getTime()) return today.toISOString();

    const tomorrow = addDays(local, 1);
    return wallClockToInstant({ ...tomorrow, hour, minute }, zone).toISOString();
  }

  if (kind === "weekly") {
    const weekdays = Array.isArray(settings.weekdays)
      ? settings.weekdays.map(Number).filter((day) => day >= 0 && day <= 6)
      : [];
    if (weekdays.length === 0) return null;

    for (let offset = 0; offset <= 7; offset += 1) {
      const day = addDays(local, offset);
      const calendarWeekday = new Date(
        Date.UTC(day.year, day.month - 1, day.day)
      ).getUTCDay();
      if (!weekdays.includes(calendarWeekday)) continue;

      const candidate = wallClockToInstant({ ...day, hour, minute }, zone);
      if (candidate.getTime() > start.getTime()) return candidate.toISOString();
    }
    return null;
  }

  return null;
}

/**
 * Adds days to a calendar date, keeping the wall-clock fields.
 *
 * @param {{year:number, month:number, day:number}} date
 * @param {number} days
 * @returns {{year:number, month:number, day:number}}
 */
function addDays(date, days) {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + days)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The plain-language names of the event triggers. */
export const EVENT_LABELS = {
  task_completed: "When a task is completed",
};

/**
 * A plain-language description of a trigger, for the UI.
 *
 * @param {object} config
 * @returns {string}
 */
export function describeTrigger(config) {
  const settings = config ?? {};
  const zone = settings.timezone ?? "UTC";

  if (EVENT_TYPES.includes(settings.kind)) {
    return EVENT_LABELS[settings.kind] ?? `On ${settings.kind}`;
  }
  if (settings.kind === "interval") {
    return `Every ${settings.everyMinutes} minutes`;
  }
  if (settings.kind === "daily") {
    return `Every day at ${settings.at ?? "--:--"} (${zone})`;
  }
  if (settings.kind === "weekly") {
    const days = Array.isArray(settings.weekdays) ? settings.weekdays : [];
    const names = days
      .map((day) => WEEKDAY_NAMES[Number(day)])
      .filter(Boolean)
      .join(", ");
    return `Every ${names || "no day selected"} at ${settings.at ?? "--:--"} (${zone})`;
  }
  if (settings.kind === "event") return "Event trigger";
  return "No trigger configured";
}

/**
 * Whether an instant falls inside the user's quiet hours.
 *
 * A window whose start is later than its end crosses midnight: 22:00-07:00 is one
 * night, not two broken ones.
 *
 * @param {Date|string|number} instant
 * @param {object} preferences {quiet_hours_start, quiet_hours_end, timezone}
 * @returns {boolean}
 */
export function isWithinQuietHours(instant, preferences) {
  const start = parseClockTime(preferences?.quiet_hours_start);
  const end = parseClockTime(preferences?.quiet_hours_end);
  if (start === null || end === null) return false;

  const zone = preferences?.timezone ?? "UTC";
  const local = timezoneParts(instant, zone);
  if (!local) return false;

  const minutes = local.hour * 60 + local.minute;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * The instant the current quiet-hours window ends.
 *
 * @param {Date|string|number} instant
 * @param {object} preferences {quiet_hours_start, quiet_hours_end, timezone}
 * @returns {string|null} the ISO instant, or null when there are no quiet hours
 */
export function quietHoursEnd(instant, preferences) {
  const start = parseClockTime(preferences?.quiet_hours_start);
  const end = parseClockTime(preferences?.quiet_hours_end);
  if (start === null || end === null) return null;

  const zone = preferences?.timezone ?? "UTC";
  const local = timezoneParts(instant, zone);
  if (!local) return null;

  const endMinutes = end;
  const crossesMidnight = start > end;
  const endDay = crossesMidnight ? addDays(local, 1) : local;

  return wallClockToInstant(
    {
      ...endDay,
      hour: Math.floor(endMinutes / 60),
      minute: endMinutes % 60,
    },
    zone
  ).toISOString();
}

/**
 * Applies quiet hours to a scheduled moment.
 *
 * @param {Date|string|number} scheduledFor
 * @param {object} preferences
 * @returns {{deferred:boolean, scheduledFor:string, deferredTo:string|null, reason:string|null}}
 */
export function applyQuietHours(scheduledFor, preferences) {
  const instant = toDate(scheduledFor);
  if (!instant) {
    return {
      deferred: false,
      scheduledFor: null,
      deferredTo: null,
      reason: "the scheduled time is not a valid instant",
    };
  }

  if (!isWithinQuietHours(instant, preferences)) {
    return {
      deferred: false,
      scheduledFor: instant.toISOString(),
      deferredTo: null,
      reason: null,
    };
  }

  const until = quietHoursEnd(instant, preferences);
  return {
    deferred: true,
    scheduledFor: instant.toISOString(),
    deferredTo: until,
    reason: "held back by quiet hours",
  };
}

/**
 * Evaluates the conditions of a workflow against the observed data.
 *
 * Every condition must hold. An UNKNOWN condition type never matches — it is
 * reported as unmatched with a reason, so a typo can never silently fire a
 * workflow on every tick.
 *
 * @param {Array<object>} conditions
 * @param {object} context {today, tasks, sessions}
 * @returns {{matched:boolean, evaluations:Array<object>}}
 */
export function evaluateConditions(conditions, context) {
  const list = Array.isArray(conditions) ? conditions : [];
  const data = context ?? {};
  const today = data.today ?? null;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];

  const evaluations = list.map((condition) => {
    const type = condition?.type;

    if (type === "task_overdue") {
      const overdue = tasks.filter(
        (task) =>
          task?.due_date &&
          today &&
          String(task.due_date).slice(0, 10) < today &&
          !CLOSED_TASK_STATUSES.includes(task.status)
      );
      return {
        type,
        matched: overdue.length > 0,
        count: overdue.length,
        detail: overdue.map((task) => task.title ?? task.id),
      };
    }

    if (type === "task_due_today") {
      const due = tasks.filter(
        (task) =>
          task?.due_date &&
          today &&
          String(task.due_date).slice(0, 10) === today &&
          !CLOSED_TASK_STATUSES.includes(task.status)
      );
      return {
        type,
        matched: due.length > 0,
        count: due.length,
        detail: due.map((task) => task.title ?? task.id),
      };
    }

    if (type === "unattributed_sessions") {
      const minimum = Number.isFinite(Number(condition?.min))
        ? Number(condition.min)
        : 1;
      const unattributed = sessions.filter(
        (session) => session?.task_id === null || session?.task_id === undefined
      );
      return {
        type,
        matched: unattributed.length >= minimum,
        count: unattributed.length,
        detail: [],
      };
    }

    return {
      type: type ?? null,
      matched: false,
      count: 0,
      detail: [],
      reason: "unknown condition type",
    };
  });

  return {
    matched: evaluations.every((evaluation) => evaluation.matched),
    evaluations,
  };
}

/**
 * How long a failed attempt waits before the next one.
 *
 * Exponential backoff: 60s, 120s, 240s ... capped at MAX_BACKOFF_SECONDS.
 *
 * @param {number} attempt the attempt that just failed (1 = the first one)
 * @param {number} baseSeconds the workflow's base backoff
 * @returns {number} the delay in seconds
 */
export function computeBackoffSeconds(attempt, baseSeconds) {
  const base = Number.isFinite(Number(baseSeconds)) ? Number(baseSeconds) : 60;
  const step = Number.isFinite(Number(attempt)) ? Math.max(1, Number(attempt)) : 1;
  const delay = base * 2 ** (step - 1);
  return Math.min(Math.max(0, Math.round(delay)), MAX_BACKOFF_SECONDS);
}

/**
 * Whether a notification may move from one state to another.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransitionNotification(from, to) {
  const allowed = NOTIFICATION_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Whether a workflow run may move from one state to another.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransitionRun(from, to) {
  const allowed = RUN_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * The duplicate-prevention key of a scheduled occurrence.
 *
 * The key is derived from the workflow and the occurrence, so every worker — and
 * every retry — computes the SAME key, and the database's unique constraint turns a
 * repeated execution into a no-op.
 *
 * @param {string} workflowId
 * @param {string|Date|number} scheduledFor
 * @returns {string}
 */
export function idempotencyKey(workflowId, scheduledFor) {
  const instant = toDate(scheduledFor);
  const stamp = instant ? instant.toISOString() : String(scheduledFor);
  return stableHash(`${workflowId}|${stamp}`);
}

/**
 * The deterministic id of the notification a run produces.
 *
 * @param {string} runId
 * @returns {string} a uuid
 */
export function notificationIdForRun(runId) {
  return deterministicUuid(`notification|${runId}`);
}

/**
 * Decides which workflows are due, which are not, and why.
 *
 * A workflow is due when its stored `next_run_at` has passed. The schedule lives in
 * the database, so it survives an application restart. A workflow that was not run
 * for a week fires ONCE when the worker returns — the missed occurrences are not
 * replayed, because a week of reminders at once is noise, not history.
 *
 * @param {object} input
 * @param {Array<object>} input.workflows
 * @param {Date|string|number} [input.now]
 * @param {object} [input.preferences]
 * @param {object} [input.context] {today, tasks, sessions}
 * @returns {{due:Array<object>, skipped:Array<object>}}
 */
export function planDueRuns({ workflows = [], now = new Date(), preferences = null, context = {} } = {}) {
  const instant = toDate(now) ?? new Date();
  const due = [];
  const skipped = [];

  for (const workflow of workflows ?? []) {
    if (!workflow) continue;

    if (!workflow.enabled) {
      skipped.push({ workflow, reason: "the workflow is switched off" });
      continue;
    }

    if (workflow.trigger_type && workflow.trigger_type !== "schedule") {
      skipped.push({
        workflow,
        reason: "the workflow is triggered by an event, not by the clock",
      });
      continue;
    }

    if (!workflow.next_run_at) {
      skipped.push({
        workflow,
        reason: "no occurrence is planned yet",
      });
      continue;
    }

    const occurrence = toDate(workflow.next_run_at);
    if (!occurrence) {
      skipped.push({ workflow, reason: "the planned occurrence is not a valid instant" });
      continue;
    }

    if (occurrence.getTime() > instant.getTime()) {
      skipped.push({
        workflow,
        reason: `the next occurrence is at ${occurrence.toISOString()}`,
      });
      continue;
    }

    const evaluation = evaluateConditions(workflow.conditions, context);
    if (!evaluation.matched) {
      skipped.push({
        workflow,
        reason: "the conditions did not match",
        evaluation,
      });
      continue;
    }

    const quiet = applyQuietHours(occurrence, preferences);
    due.push({
      workflow,
      scheduledFor: occurrence.toISOString(),
      deferred: quiet.deferred,
      deferredTo: quiet.deferredTo,
      evaluation,
    });
  }

  return { due, skipped };
}

/**
 * Collects the events that happened after a cursor.
 *
 * WHAT IS AN EVENT: a fact that already happened and is stored — here, a task that
 * reached the `completed` state. The collection only READS rows; it never invents an
 * event.
 *
 * WHY A CURSOR: the worker must not walk the whole task table on every tick. The
 * cursor is the watermark of the last event that was processed; everything after it
 * is new. A cursor of `null` means "everything so far" — the first tick of a new
 * workflow therefore sees the tasks that were completed before it existed, which is
 * correct: the event happened.
 *
 * @param {object} input
 * @param {Array<object>} input.tasks the task rows
 * @param {string|Date|null} [input.since] the cursor (ISO instant)
 * @param {string|Date} [input.until] do not collect events after this instant
 * @returns {Array<object>} the events, oldest first
 */
export function collectTaskEvents({ tasks = [], since = null, until = null } = {}) {
  const from = toDate(since);
  const to = toDate(until);
  const list = Array.isArray(tasks) ? tasks : [];

  const events = [];
  for (const task of list) {
    if (!task) continue;
    if (task.status !== "completed") continue;

    const occurredAt = toDate(task.completed_at);
    if (!occurredAt) continue;

    if (from && occurredAt.getTime() <= from.getTime()) continue;
    if (to && occurredAt.getTime() > to.getTime()) continue;

    events.push({
      type: "task_completed",
      taskId: task.id,
      occurredAt: occurredAt.toISOString(),
      task: {
        id: task.id,
        title: task.title ?? null,
        priority: task.priority ?? null,
        status: task.status,
      },
    });
  }

  events.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  return events;
}

/**
 * Decides which event workflows act on which events, and why.
 *
 * The same rules as the clock: a disabled workflow does nothing, the conditions must
 * hold, and every event gets a deterministic idempotency key — the same completion
 * can never fire the same workflow twice.
 *
 * @param {object} input
 * @param {Array<object>} input.workflows
 * @param {Array<object>} input.events the collected events, oldest first
 * @param {object} [input.context] {today, tasks, sessions}
 * @returns {{due:Array<object>, skipped:Array<object>}}
 */
export function planEventRuns({ workflows = [], events = [], context = {} } = {}) {
  const due = [];
  const skipped = [];
  const list = Array.isArray(events) ? events : [];

  for (const workflow of workflows ?? []) {
    if (!workflow) continue;

    if (!workflow.enabled) {
      skipped.push({ workflow, reason: "the workflow is switched off" });
      continue;
    }

    if (workflow.trigger_type !== "event") {
      skipped.push({
        workflow,
        reason: "the workflow is triggered by the clock, not by an event",
      });
      continue;
    }

    const kind = workflow.trigger_config?.kind;
    if (!EVENT_TYPES.includes(kind)) {
      skipped.push({
        workflow,
        reason: `the event trigger ${kind ?? "missing"} is not implemented`,
      });
      continue;
    }

    for (const event of list) {
      if (event.type !== kind) continue;

      const evaluation = evaluateConditions(workflow.conditions, context);
      if (!evaluation.matched) {
        skipped.push({
          workflow,
          event,
          reason: "the conditions did not match",
          evaluation,
        });
        continue;
      }

      due.push({
        workflow,
        event,
        scheduledFor: event.occurredAt,
        evaluation,
        idempotencyKey: idempotencyKey(
          workflow.id,
          `event:${event.type}:${event.taskId}:${event.occurredAt}`
        ),
      });
    }
  }

  return { due, skipped };
}

/**
 * Decides what happens to a run that failed.
 *
 * @param {object} input
 * @param {object} input.run the run row
 * @param {object} input.workflow the workflow row
 * @param {Date|string|number} [input.now]
 * @returns {{retry:boolean, status:string, attempt:number, nextAttemptAt:string|null, reason:string}}
 */
export function planRetry({ run, workflow, now = new Date() } = {}) {
  const instant = toDate(now) ?? new Date();
  const maxAttempts = Number(workflow?.max_attempts) || 1;
  const attempt = Number(run?.attempt) || 1;

  if (attempt >= maxAttempts) {
    return {
      retry: false,
      status: "failed",
      attempt,
      nextAttemptAt: null,
      reason: `the run failed ${attempt} time(s) and the retry limit is reached`,
    };
  }

  const delay = computeBackoffSeconds(attempt, workflow?.retry_backoff_seconds);
  return {
    retry: true,
    status: "scheduled",
    attempt: attempt + 1,
    nextAttemptAt: new Date(instant.getTime() + delay * 1000).toISOString(),
    reason: `the next attempt waits ${delay} second(s)`,
  };
}

/**
 * Builds the notification a run delivers.
 *
 * The body is composed from what was actually OBSERVED — the evaluated conditions
 * and their counts. Nothing is invented: if no task was overdue, the workflow does
 * not run at all.
 *
 * @param {object} input
 * @param {object} input.workflow
 * @param {object} input.run
 * @param {object} [input.evaluation] the evaluated conditions
 * @param {string} [input.scheduledFor] when the notification should arrive
 * @returns {object} the notification row to write
 */
export function buildNotification({
  workflow,
  run,
  evaluation = null,
  scheduledFor = null,
  event = null,
} = {}) {
  const action = workflow?.action_config ?? {};
  const kind = action.kind ?? workflow?.name ?? "workflow";
  const title = action.title ?? workflow?.name ?? "Notification";

  const details = (evaluation?.evaluations ?? [])
    .map((item) => `${item.type}: ${item.count}`)
    .join(", ");

  const eventDetail = event?.task?.title
    ? `The task "${event.task.title}" was completed.`
    : null;

  const body = action.body
    ? String(action.body)
    : eventDetail ?? (details ? `Observed — ${details}.` : null);

  return {
    id: notificationIdForRun(run?.id),
    workflow_id: workflow?.id ?? null,
    run_id: run?.id ?? null,
    channel: workflow?.channel ?? "in_app",
    kind,
    title,
    body,
    status: "scheduled",
    scheduled_for: scheduledFor,
    payload: {
      evaluations: evaluation?.evaluations ?? [],
      workflow_name: workflow?.name ?? null,
      event: event
        ? {
            type: event.type,
            task_id: event.taskId,
            occurred_at: event.occurredAt,
          }
        : null,
    },
  };
}
