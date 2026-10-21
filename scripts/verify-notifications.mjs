// Central Hub — Phase 6 notification and workflow assertions.
//
// The repository has no test framework, so the domain rules are verified with plain
// Node assertions (same pattern as the Phase 4 and Phase 5 verification scripts).
//
// Run:  node scripts/verify-notifications.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import { readFileSync } from "node:fs";
import {
  APPROVAL_STATUSES,
  CHANNELS,
  NOTIFICATION_STATUSES,
  RUN_STATUSES,
  applyQuietHours,
  collectTaskEvents,
  buildNotification,
  canTransitionNotification,
  canTransitionRun,
  computeBackoffSeconds,
  describeTrigger,
  evaluateConditions,
  formatClockTime,
  idempotencyKey,
  isWithinQuietHours,
  nextRunAt,
  notificationIdForRun,
  parseClockTime,
  planDueRuns,
  planEventRuns,
  planRetry,
  quietHoursEnd,
  wallClockToInstant,
  timezoneParts,
} from "../src/features/notifications/workflowEngine.js";

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

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message} (expected ${b}, got ${a})`);
}

// ---------------------------------------------------------------------------
// Clock parsing
// ---------------------------------------------------------------------------

check("a 'HH:MM' time parses into minutes since midnight", () => {
  assertEqual(parseClockTime("09:30"), 570, "09:30");
  assertEqual(parseClockTime("00:00"), 0, "00:00");
  assertEqual(parseClockTime("23:59"), 1439, "23:59");
});

check("an invalid time is rejected, not guessed", () => {
  assertEqual(parseClockTime("24:00"), null, "24:00 is not a time");
  assertEqual(parseClockTime("9:60"), null, "9:60 is not a time");
  assertEqual(parseClockTime("nine"), null, "words are not a time");
  assertEqual(parseClockTime(null), null, "null is not a time");
  assertEqual(parseClockTime(930), null, "a number is not a time");
});

check("minutes since midnight round-trip through the clock format", () => {
  assertEqual(formatClockTime(570), "09:30", "570");
  assertEqual(formatClockTime(0), "00:00", "0");
  assertEqual(formatClockTime(1439), "23:59", "1439");
});

// ---------------------------------------------------------------------------
// Timezone handling
// ---------------------------------------------------------------------------

check("a wall-clock time in a timezone resolves to the right instant", () => {
  // 09:00 in Bangkok (UTC+7) is 02:00 UTC.
  const instant = wallClockToInstant(
    { year: 2026, month: 10, day: 21, hour: 9, minute: 0 },
    "Asia/Bangkok"
  );
  assertEqual(instant.toISOString(), "2026-10-21T02:00:00.000Z", "Bangkok 09:00");
});

check("the wall-clock parts of an instant are read in its timezone", () => {
  const parts = timezoneParts("2026-10-21T02:00:00.000Z", "Asia/Bangkok");
  assertEqual(parts.hour, 9, "hour in Bangkok");
  assertEqual(parts.day, 21, "day in Bangkok");
  assertEqual(parts.weekday, 3, "21 October 2026 is a Wednesday");
});

check("an unknown timezone falls back to UTC instead of losing the schedule", () => {
  const parts = timezoneParts("2026-10-21T02:00:00.000Z", "Not/AZone");
  assertEqual(parts.hour, 2, "hour in UTC");
});

// ---------------------------------------------------------------------------
// nextRunAt
// ---------------------------------------------------------------------------

check("a daily trigger fires at its wall-clock time, later today", () => {
  const next = nextRunAt(
    { kind: "daily", at: "09:00", timezone: "Asia/Bangkok" },
    "2026-10-21T00:00:00.000Z",
    "Asia/Bangkok"
  );
  // 09:00 Bangkok = 02:00 UTC.
  assertEqual(next, "2026-10-21T02:00:00.000Z", "next daily occurrence");
});

check("a daily trigger that already passed today fires tomorrow", () => {
  const next = nextRunAt(
    { kind: "daily", at: "09:00", timezone: "Asia/Bangkok" },
    "2026-10-21T05:00:00.000Z",
    "Asia/Bangkok"
  );
  assertEqual(next, "2026-10-22T02:00:00.000Z", "next daily occurrence");
});

check("a daily trigger follows the wall clock across a DST change", () => {
  // Europe/Berlin switches to summer time on 29 March 2026: 09:00 local is
  // 07:00 UTC before the change and 08:00 UTC on the day of the change.
  const before = nextRunAt(
    { kind: "daily", at: "09:00", timezone: "Europe/Berlin" },
    "2026-03-28T00:00:00.000Z"
  );
  const after = nextRunAt(
    { kind: "daily", at: "09:00", timezone: "Europe/Berlin" },
    "2026-03-29T00:00:00.000Z"
  );
  assertEqual(before, "2026-03-28T08:00:00.000Z", "before the DST change");
  assertEqual(after, "2026-03-29T07:00:00.000Z", "on the day of the DST change");
});

check("a weekly trigger fires on the next selected weekday", () => {
  // 21 October 2026 is a Wednesday; the next Friday is the 23rd.
  const next = nextRunAt(
    { kind: "weekly", at: "08:00", weekdays: [5], timezone: "UTC" },
    "2026-10-21T00:00:00.000Z"
  );
  assertEqual(next, "2026-10-23T08:00:00.000Z", "next Friday");
});

check("a weekly trigger with no weekday selected is refused", () => {
  const next = nextRunAt(
    { kind: "weekly", at: "08:00", weekdays: [], timezone: "UTC" },
    "2026-10-21T00:00:00.000Z"
  );
  assertEqual(next, null, "no weekday means no occurrence");
});

check("an interval trigger fires every N minutes", () => {
  const next = nextRunAt(
    { kind: "interval", everyMinutes: 15 },
    "2026-10-21T00:00:00.000Z"
  );
  assertEqual(next, "2026-10-21T00:15:00.000Z", "next interval occurrence");
});

check("an invalid trigger configuration yields no occurrence", () => {
  assertEqual(nextRunAt({ kind: "daily", at: "nonsense" }, "2026-10-21T00:00:00.000Z"), null, "bad time");
  assertEqual(nextRunAt({ kind: "interval", everyMinutes: 0 }, "2026-10-21T00:00:00.000Z"), null, "zero minutes");
  assertEqual(nextRunAt({ kind: "hourly" }, "2026-10-21T00:00:00.000Z"), null, "unknown kind");
  assertEqual(nextRunAt(null, "2026-10-21T00:00:00.000Z"), null, "no configuration");
});

check("a trigger is described in plain language", () => {
  assertEqual(
    describeTrigger({ kind: "daily", at: "09:00", timezone: "Europe/Berlin" }),
    "Every day at 09:00 (Europe/Berlin)",
    "daily description"
  );
  assertEqual(
    describeTrigger({ kind: "interval", everyMinutes: 15 }),
    "Every 15 minutes",
    "interval description"
  );
});

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

check("an instant inside the quiet hours is recognised", () => {
  const preferences = {
    quiet_hours_start: "22:00",
    quiet_hours_end: "07:00",
    timezone: "UTC",
  };
  assertEqual(isWithinQuietHours("2026-10-21T23:00:00.000Z", preferences), true, "23:00 is quiet");
  assertEqual(isWithinQuietHours("2026-10-21T12:00:00.000Z", preferences), false, "12:00 is not quiet");
  assertEqual(isWithinQuietHours("2026-10-21T06:59:00.000Z", preferences), true, "06:59 is quiet");
  assertEqual(isWithinQuietHours("2026-10-21T07:00:00.000Z", preferences), false, "07:00 is the end");
});

check("quiet hours that do not cross midnight work as one window", () => {
  const preferences = {
    quiet_hours_start: "01:00",
    quiet_hours_end: "05:00",
    timezone: "UTC",
  };
  assertEqual(isWithinQuietHours("2026-10-21T02:00:00.000Z", preferences), true, "02:00 is quiet");
  assertEqual(isWithinQuietHours("2026-10-21T00:30:00.000Z", preferences), false, "00:30 is not quiet");
  assertEqual(isWithinQuietHours("2026-10-21T06:00:00.000Z", preferences), false, "06:00 is not quiet");
});

check("without preferences there are no quiet hours", () => {
  assertEqual(isWithinQuietHours("2026-10-21T23:00:00.000Z", null), false, "no preferences");
  assertEqual(isWithinQuietHours("2026-10-21T23:00:00.000Z", {}), false, "empty preferences");
});

check("the quiet-hours window ends at the configured time", () => {
  const preferences = {
    quiet_hours_start: "22:00",
    quiet_hours_end: "07:00",
    timezone: "UTC",
  };
  assertEqual(
    quietHoursEnd("2026-10-21T23:00:00.000Z", preferences),
    "2026-10-22T07:00:00.000Z",
    "the window ends the next morning"
  );
});

check("a notification due inside the quiet hours is held back until they end", () => {
  const preferences = {
    quiet_hours_start: "22:00",
    quiet_hours_end: "07:00",
    timezone: "UTC",
  };
  const result = applyQuietHours("2026-10-21T23:00:00.000Z", preferences);
  assertEqual(result.deferred, true, "deferred");
  assertEqual(result.deferredTo, "2026-10-22T07:00:00.000Z", "deferred until");
  assertEqual(result.scheduledFor, "2026-10-21T23:00:00.000Z", "the original time is kept");
});

check("a notification due outside the quiet hours is not deferred", () => {
  const preferences = {
    quiet_hours_start: "22:00",
    quiet_hours_end: "07:00",
    timezone: "UTC",
  };
  const result = applyQuietHours("2026-10-21T09:00:00.000Z", preferences);
  assertEqual(result.deferred, false, "not deferred");
  assertEqual(result.deferredTo, null, "nothing to defer to");
});

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

check("an overdue task satisfies the 'task_overdue' condition", () => {
  const result = evaluateConditions([{ type: "task_overdue" }], {
    today: "2026-10-21",
    tasks: [
      { id: "1", title: "Old", due_date: "2026-10-19", status: "todo" },
      { id: "2", title: "Later", due_date: "2026-10-25", status: "todo" },
    ],
  });
  assertEqual(result.matched, true, "matched");
  assertEqual(result.evaluations[0].count, 1, "one overdue task");
});

check("a completed or cancelled task is not overdue", () => {
  const result = evaluateConditions([{ type: "task_overdue" }], {
    today: "2026-10-21",
    tasks: [{ id: "1", title: "Done", due_date: "2026-10-19", status: "completed" }],
  });
  assertEqual(result.matched, false, "a completed task is not overdue");
});

check("a task due today satisfies the 'task_due_today' condition", () => {
  const result = evaluateConditions([{ type: "task_due_today" }], {
    today: "2026-10-21",
    tasks: [
      { id: "1", title: "Today", due_date: "2026-10-21", status: "todo" },
      { id: "2", title: "Tomorrow", due_date: "2026-10-22", status: "todo" },
    ],
  });
  assertEqual(result.matched, true, "matched");
  assertEqual(result.evaluations[0].count, 1, "one task due today");
});

check("unattributed sessions satisfy their condition", () => {
  const result = evaluateConditions([{ type: "unattributed_sessions" }], {
    today: "2026-10-21",
    sessions: [{ id: "1", task_id: null }, { id: "2", task_id: "task-1" }],
  });
  assertEqual(result.matched, true, "matched");
  assertEqual(result.evaluations[0].count, 1, "one unattributed session");
});

check("a condition with a minimum count is honoured", () => {
  const result = evaluateConditions([{ type: "unattributed_sessions", min: 2 }], {
    sessions: [{ id: "1", task_id: null }],
  });
  assertEqual(result.matched, false, "one session is not two");
});

check("an unknown condition never matches — it is reported, not ignored", () => {
  const result = evaluateConditions([{ type: "task_vibes" }], { today: "2026-10-21" });
  assertEqual(result.matched, false, "unknown conditions do not fire a workflow");
  assertEqual(result.evaluations[0].reason, "unknown condition type", "the reason is reported");
});

check("every condition must hold", () => {
  const result = evaluateConditions(
    [{ type: "task_overdue" }, { type: "task_due_today" }],
    {
      today: "2026-10-21",
      tasks: [{ id: "1", due_date: "2026-10-19", status: "todo" }],
    }
  );
  assertEqual(result.matched, false, "one unmet condition is enough to hold the workflow back");
});

check("no conditions means the workflow always acts", () => {
  const result = evaluateConditions([], { today: "2026-10-21" });
  assertEqual(result.matched, true, "matched");
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

check("a failed attempt waits longer with every retry", () => {
  assertEqual(computeBackoffSeconds(1, 60), 60, "first retry");
  assertEqual(computeBackoffSeconds(2, 60), 120, "second retry");
  assertEqual(computeBackoffSeconds(3, 60), 240, "third retry");
});

check("the backoff is capped at an hour", () => {
  assertEqual(computeBackoffSeconds(20, 60), 3600, "capped");
});

check("a run below the attempt limit is retried", () => {
  const retry = planRetry({
    run: { attempt: 1 },
    workflow: { max_attempts: 3, retry_backoff_seconds: 60 },
    now: "2026-10-21T00:00:00.000Z",
  });
  assertEqual(retry.retry, true, "retried");
  assertEqual(retry.status, "scheduled", "the run waits for its next attempt");
  assertEqual(retry.attempt, 2, "the attempt counter grows");
  assertEqual(retry.nextAttemptAt, "2026-10-21T00:01:00.000Z", "the next attempt is in a minute");
});

check("a run at the attempt limit fails for good", () => {
  const retry = planRetry({
    run: { attempt: 3 },
    workflow: { max_attempts: 3, retry_backoff_seconds: 60 },
    now: "2026-10-21T00:00:00.000Z",
  });
  assertEqual(retry.retry, false, "not retried");
  assertEqual(retry.status, "failed", "the run failed");
  assertEqual(retry.nextAttemptAt, null, "no further attempt");
});

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

check("a notification cannot be delivered before it was sent", () => {
  assertEqual(canTransitionNotification("scheduled", "delivered"), false, "scheduled -> delivered");
  assertEqual(canTransitionNotification("scheduled", "sent"), true, "scheduled -> sent");
  assertEqual(canTransitionNotification("sent", "delivered"), true, "sent -> delivered");
  assertEqual(canTransitionNotification("delivered", "acknowledged"), true, "delivered -> acknowledged");
});

check("an acknowledged notification is final", () => {
  assertEqual(canTransitionNotification("acknowledged", "sent"), false, "no going back");
  assertEqual(canTransitionNotification("failed", "sent"), false, "a failed delivery is final");
  assertEqual(canTransitionNotification("nonsense", "sent"), false, "an unknown state has no transitions");
});

check("a run must run before it can succeed", () => {
  assertEqual(canTransitionRun("scheduled", "succeeded"), false, "scheduled -> succeeded");
  assertEqual(canTransitionRun("scheduled", "running"), true, "scheduled -> running");
  assertEqual(canTransitionRun("running", "succeeded"), true, "running -> succeeded");
  assertEqual(canTransitionRun("running", "awaiting_approval"), true, "running -> awaiting_approval");
  assertEqual(canTransitionRun("awaiting_approval", "running"), true, "the approved run runs");
  assertEqual(canTransitionRun("succeeded", "running"), false, "a succeeded run is final");
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

check("the same occurrence always produces the same idempotency key", () => {
  const first = idempotencyKey("workflow-1", "2026-10-21T02:00:00.000Z");
  const second = idempotencyKey("workflow-1", "2026-10-21T02:00:00.000Z");
  assertEqual(first, second, "the key is stable");
});

check("a different occurrence produces a different idempotency key", () => {
  const first = idempotencyKey("workflow-1", "2026-10-21T02:00:00.000Z");
  const second = idempotencyKey("workflow-1", "2026-10-22T02:00:00.000Z");
  assert(first !== second, "the keys differ");
});

check("a different workflow produces a different idempotency key", () => {
  const first = idempotencyKey("workflow-1", "2026-10-21T02:00:00.000Z");
  const second = idempotencyKey("workflow-2", "2026-10-21T02:00:00.000Z");
  assert(first !== second, "the keys differ");
});

check("the notification of a run always has the same id", () => {
  const first = notificationIdForRun("run-1");
  const second = notificationIdForRun("run-1");
  assertEqual(first, second, "the id is stable");
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first),
    "the id is uuid-shaped"
  );
  assert(first !== notificationIdForRun("run-2"), "different runs get different ids");
});

// ---------------------------------------------------------------------------
// planDueRuns
// ---------------------------------------------------------------------------

const baseWorkflow = {
  id: "workflow-1",
  name: "Overdue check",
  enabled: true,
  trigger_type: "schedule",
  trigger_config: { kind: "daily", at: "09:00", timezone: "UTC" },
  conditions: [{ type: "task_overdue" }],
  action_config: { kind: "task_overdue", title: "Overdue tasks" },
  next_run_at: "2026-10-21T09:00:00.000Z",
};

const overdueContext = {
  today: "2026-10-21",
  tasks: [{ id: "1", title: "Old", due_date: "2026-10-19", status: "todo" }],
  sessions: [],
};

check("a workflow whose occurrence has passed is due", () => {
  const plan = planDueRuns({
    workflows: [baseWorkflow],
    now: "2026-10-21T10:00:00.000Z",
    context: overdueContext,
  });
  assertEqual(plan.due.length, 1, "one due workflow");
  assertEqual(plan.due[0].scheduledFor, "2026-10-21T09:00:00.000Z", "the occurrence time");
});

check("a workflow whose occurrence is in the future is not due", () => {
  const plan = planDueRuns({
    workflows: [baseWorkflow],
    now: "2026-10-21T08:00:00.000Z",
    context: overdueContext,
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(plan.skipped.length, 1, "the workflow is reported as not due");
});

check("a switched-off workflow is not due, and says why", () => {
  const plan = planDueRuns({
    workflows: [{ ...baseWorkflow, enabled: false }],
    now: "2026-10-21T10:00:00.000Z",
    context: overdueContext,
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(plan.skipped[0].reason, "the workflow is switched off", "the reason is reported");
});

check("an event trigger is not planned by the clock, and says why", () => {
  const plan = planDueRuns({
    workflows: [{ ...baseWorkflow, trigger_type: "event" }],
    now: "2026-10-21T10:00:00.000Z",
    context: overdueContext,
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(
    plan.skipped[0].reason,
    "the workflow is triggered by an event, not by the clock",
    "the reason is reported"
  );
});

check("a workflow without a planned occurrence is not due", () => {
  const plan = planDueRuns({
    workflows: [{ ...baseWorkflow, next_run_at: null }],
    now: "2026-10-21T10:00:00.000Z",
    context: overdueContext,
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(plan.skipped[0].reason, "no occurrence is planned yet", "the reason is reported");
});

check("a workflow whose conditions do not hold is not due", () => {
  const plan = planDueRuns({
    workflows: [baseWorkflow],
    now: "2026-10-21T10:00:00.000Z",
    context: { today: "2026-10-21", tasks: [], sessions: [] },
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(plan.skipped[0].reason, "the conditions did not match", "the reason is reported");
});

check("a due workflow that falls into the quiet hours is deferred, not dropped", () => {
  const plan = planDueRuns({
    workflows: [baseWorkflow],
    now: "2026-10-21T10:00:00.000Z",
    preferences: {
      quiet_hours_start: "09:00",
      quiet_hours_end: "11:00",
      timezone: "UTC",
    },
    context: overdueContext,
  });
  assertEqual(plan.due.length, 1, "the workflow is still due");
  assertEqual(plan.due[0].deferred, true, "deferred");
  assertEqual(plan.due[0].deferredTo, "2026-10-21T11:00:00.000Z", "deferred until the window ends");
});

// ---------------------------------------------------------------------------
// The notification a run delivers
// ---------------------------------------------------------------------------

check("a notification is built from what was observed", () => {
  const evaluation = evaluateConditions([{ type: "task_overdue" }], overdueContext);
  const notification = buildNotification({
    workflow: baseWorkflow,
    run: { id: "run-1" },
    evaluation,
    scheduledFor: "2026-10-21T09:00:00.000Z",
  });
  assertEqual(notification.title, "Overdue tasks", "the title");
  assertEqual(notification.status, "scheduled", "a new notification is scheduled, not delivered");
  assertEqual(notification.channel, "in_app", "the only channel that exists");
  assert(notification.body.includes("task_overdue: 1"), "the body reports what was observed");
  assertEqual(notification.payload.evaluations[0].count, 1, "the payload carries the count");
});

check("a notification without a condition result does not invent a body", () => {
  const notification = buildNotification({
    workflow: { ...baseWorkflow, action_config: {} },
    run: { id: "run-1" },
    evaluation: null,
  });
  assertEqual(notification.body, null, "no body is invented");
  assertEqual(notification.title, "Overdue check", "the workflow name is the fallback title");
});

// ---------------------------------------------------------------------------
// Event triggers
// ---------------------------------------------------------------------------

const eventWorkflow = {
  id: "workflow-event",
  name: "Task done",
  enabled: true,
  trigger_type: "event",
  trigger_config: { kind: "task_completed" },
  conditions: [],
  action_config: { kind: "task_completed", title: "Task completed" },
  next_run_at: null,
  event_cursor: null,
};

const completedTask = {
  id: "task-1",
  title: "Write the report",
  status: "completed",
  priority: "high",
  completed_at: "2026-10-21T10:00:00.000Z",
};

check("only a completed task produces an event", () => {
  const events = collectTaskEvents({
    tasks: [
      completedTask,
      { id: "task-2", title: "Open", status: "todo", completed_at: null },
      { id: "task-3", title: "Done but no timestamp", status: "completed", completed_at: null },
    ],
  });
  assertEqual(events.length, 1, "one event");
  assertEqual(events[0].type, "task_completed", "the event type");
  assertEqual(events[0].taskId, "task-1", "the task");
  assertEqual(events[0].occurredAt, "2026-10-21T10:00:00.000Z", "when it happened");
});

check("the cursor hides the events that were already processed", () => {
  const events = collectTaskEvents({
    tasks: [completedTask],
    since: "2026-10-21T10:00:00.000Z",
  });
  assertEqual(events.length, 0, "the event at the cursor is not new");
});

check("the events after the cursor are collected, oldest first", () => {
  const events = collectTaskEvents({
    tasks: [
      { ...completedTask, id: "task-b", completed_at: "2026-10-21T12:00:00.000Z" },
      { ...completedTask, id: "task-a", completed_at: "2026-10-21T11:00:00.000Z" },
    ],
    since: "2026-10-21T10:00:00.000Z",
  });
  assertEqual(events.length, 2, "two events");
  assertEqual(events[0].taskId, "task-a", "the oldest first");
});

check("an event workflow acts on the event", () => {
  const plan = planEventRuns({
    workflows: [eventWorkflow],
    events: collectTaskEvents({ tasks: [completedTask] }),
    context: { today: "2026-10-21" },
  });
  assertEqual(plan.due.length, 1, "one due event");
  assertEqual(plan.due[0].scheduledFor, "2026-10-21T10:00:00.000Z", "the occurrence time");
  assert(plan.due[0].idempotencyKey, "the event carries its idempotency key");
});

check("the same event always produces the same idempotency key", () => {
  const first = planEventRuns({
    workflows: [eventWorkflow],
    events: collectTaskEvents({ tasks: [completedTask] }),
  });
  const second = planEventRuns({
    workflows: [eventWorkflow],
    events: collectTaskEvents({ tasks: [completedTask] }),
  });
  assertEqual(
    first.due[0].idempotencyKey,
    second.due[0].idempotencyKey,
    "the key is stable"
  );

  const other = planEventRuns({
    workflows: [eventWorkflow],
    events: collectTaskEvents({
      tasks: [{ ...completedTask, id: "task-2" }],
    }),
  });
  assert(
    first.due[0].idempotencyKey !== other.due[0].idempotencyKey,
    "a different task produces a different key"
  );
});

check("a disabled event workflow acts on nothing", () => {
  const plan = planEventRuns({
    workflows: [{ ...eventWorkflow, enabled: false }],
    events: collectTaskEvents({ tasks: [completedTask] }),
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(plan.skipped[0].reason, "the workflow is switched off", "the reason is reported");
});

check("a clock workflow is not an event workflow", () => {
  const plan = planEventRuns({
    workflows: [baseWorkflow],
    events: collectTaskEvents({ tasks: [completedTask] }),
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(
    plan.skipped[0].reason,
    "the workflow is triggered by the clock, not by an event",
    "the reason is reported"
  );
});

check("an event trigger that is not implemented is refused with a reason", () => {
  const plan = planEventRuns({
    workflows: [
      { ...eventWorkflow, trigger_config: { kind: "task_vibes" } },
    ],
    events: collectTaskEvents({ tasks: [completedTask] }),
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(
    plan.skipped[0].reason,
    "the event trigger task_vibes is not implemented",
    "the reason is reported"
  );
});

check("an event whose conditions do not hold is not delivered", () => {
  const plan = planEventRuns({
    workflows: [
      { ...eventWorkflow, conditions: [{ type: "task_overdue" }] },
    ],
    events: collectTaskEvents({ tasks: [completedTask] }),
    context: { today: "2026-10-21", tasks: [] },
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(plan.skipped[0].reason, "the conditions did not match", "the reason is reported");
});

check("a clock workflow is skipped by the clock planner with a reason", () => {
  const plan = planDueRuns({
    workflows: [eventWorkflow],
    now: "2026-10-21T12:00:00.000Z",
    context: { today: "2026-10-21" },
  });
  assertEqual(plan.due.length, 0, "nothing is due");
  assertEqual(
    plan.skipped[0].reason,
    "the workflow is triggered by an event, not by the clock",
    "the reason is reported"
  );
});

check("an event trigger is described in plain language", () => {
  assertEqual(
    describeTrigger({ kind: "task_completed" }),
    "When a task is completed",
    "the event description"
  );
});

check("an event notification reports the task that was completed", () => {
  const notification = buildNotification({
    workflow: eventWorkflow,
    run: { id: "run-event" },
    evaluation: { evaluations: [] },
    scheduledFor: "2026-10-21T10:00:00.000Z",
    event: {
      type: "task_completed",
      taskId: "task-1",
      occurredAt: "2026-10-21T10:00:00.000Z",
      task: { id: "task-1", title: "Write the report" },
    },
  });
  assertEqual(notification.title, "Task completed", "the title");
  assert(
    notification.body.includes("Write the report"),
    "the body names the task that was completed"
  );
  assertEqual(
    notification.payload.event.task_id,
    "task-1",
    "the payload carries the event"
  );
});

// ---------------------------------------------------------------------------
// The summary of the contract
// ---------------------------------------------------------------------------

check("the published vocabularies match the ones the database constrains", () => {
  const migration = readFileSync(
    "supabase/migrations/20261020120000_notifications_workflows_phase6.sql",
    "utf8"
  );

  // Read the CHECK constraints themselves, not the whole file: a status mentioned in
  // a comment must not make this assertion pass.
  const statusSets = [...migration.matchAll(/check \(status in \(([^)]*)\)\)/g)].map(
    (match) =>
      match[1]
        .split(",")
        .map((value) => value.trim().replace(/'/g, ""))
        .filter(Boolean)
        .sort()
  );

  const channelSets = [
    ...migration.matchAll(/check \(channel in \(([^)]*)\)\)/g),
  ].map((match) =>
    match[1]
      .split(",")
      .map((value) => value.trim().replace(/'/g, ""))
      .filter(Boolean)
      .sort()
  );

  const sorted = (values) => [...values].sort();
  const sameSet = (actual, expected) =>
    actual.length === expected.length &&
    actual.every((value, index) => value === sorted(expected)[index]);

  const expectedStatuses = [
    sorted(RUN_STATUSES),
    sorted(NOTIFICATION_STATUSES),
    sorted(APPROVAL_STATUSES),
  ];

  assertEqual(statusSets.length, expectedStatuses.length, "one status CHECK per table");

  for (const expected of expectedStatuses) {
    assert(
      statusSets.some((actual) => sameSet(actual, expected)),
      `the migration must constrain exactly ${JSON.stringify(expected)}`
    );
  }

  assert(channelSets.length > 0, "the channel must be constrained");
  for (const actual of channelSets) {
    assert(sameSet(actual, CHANNELS), `the channel CHECK must be exactly ${JSON.stringify(CHANNELS)}`);
  }
});

// ---------------------------------------------------------------------------

console.log("");
console.log(`${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  console.log("");
  for (const failure of failures) console.log(`FAILED: ${failure.name}\n        ${failure.message}`);
  process.exitCode = 1;
}
