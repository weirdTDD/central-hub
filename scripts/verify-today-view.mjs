// Sentral Hub — day view assertions.
//
// The repository has no test framework, so the day-bucketing rules are verified
// with plain Node assertions.
//
// Run:  node scripts/verify-today-view.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import { activeDayKeys, streakInWeek } from "../src/dashboard/homeBoard.js";
import {
  PLAN_ITEM_KEYS,
  addDays,
  buildDayView,
  differenceText,
  durationText,
  civilToInstant,
  formatClock,
  greetingFor,
  personName,
  pickReminder,
  plannedTotalText,
  primaryAction,
  recordedTotalText,
  tasksForDay,
  todayKey,
  weekWindow,
} from "../src/dashboard/todayView.js";

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

const DAY = "2026-10-20";
const ZONE = "UTC";

console.log("Sentral Hub — day view assertions\n");

check("Tuesday 20 Oct 2026 sits in Mon 19 – Sun 25", () => {
  const week = weekWindow(DAY);
  assertEqual(week.startKey, "2026-10-19", "week starts Monday");
  assertEqual(week.endKey, "2026-10-25", "week ends Sunday");
  assertEqual(week.days[0].weekday, "Mon", "first label");
  assertEqual(week.days[1].key, DAY, "Tuesday is the selected civil day");
  assertEqual(week.days[6].weekday, "Sun", "last label");
});

check("an impossible civil date has no week", () => {
  assertEqual(weekWindow("2026-02-31"), null, "31 Feb is not a day");
  assertEqual(addDays(DAY, 1), "2026-10-21", "the next civil day");
});

check("the local day follows the timezone, not UTC", () => {
  const instant = new Date("2026-10-21T02:00:00Z");
  assertEqual(todayKey("UTC", instant), "2026-10-21", "UTC day");
  assertEqual(todayKey("America/New_York", instant), "2026-10-20", "New York day");
});

check("the greeting follows the clock in that timezone", () => {
  const morning = new Date("2026-10-20T08:30:00Z");
  const afternoon = new Date("2026-10-20T15:00:00Z");
  const evening = new Date("2026-10-20T20:00:00Z");
  assertEqual(greetingFor(morning, ZONE), "Morning", "morning");
  assertEqual(greetingFor(afternoon, ZONE), "Afternoon", "afternoon");
  assertEqual(greetingFor(evening, ZONE), "Evening", "evening");
  assertEqual(
    greetingFor(new Date("2026-10-21T02:00:00Z"), "America/New_York"),
    "Evening",
    "22:00 in New York"
  );
});

check("the name comes from the profile, then the email, and is otherwise blank", () => {
  assertEqual(
    personName({ user_metadata: { full_name: "Ada Lovelace" }, email: "ada@example.com" }),
    "Ada Lovelace",
    "profile name"
  );
  assertEqual(personName({ email: "ada@example.com" }), "ada", "email local part");
  assertEqual(personName({}), "", "no placeholder name");
});

check("a task due that day has no clock time", () => {
  const [task] = tasksForDay(
    [
      {
        id: "t1",
        title: "Write the notes",
        status: "todo",
        priority: "high",
        due_date: "2026-10-20T15:00:00Z",
        estimated_duration_seconds: 1800,
      },
    ],
    DAY
  );
  assert(task, "the task is on the plan");
  assertEqual(task.dueDate, DAY, "the due date is the civil day");
  assert(!String(task.dueDate).includes("T"), "the due date carries no time");
  assert(!("startedAt" in task), "no start time");
  assert(!("clock" in task), "no clock");
  const keys = Object.keys(task).sort();
  assertEqual(keys.join(","), [...PLAN_ITEM_KEYS].sort().join(","), "plan fields only");
});

check("the next task is the first open task, and a todo task cannot be completed", () => {
  const plan = tasksForDay(
    [
      { id: "done", title: "Filed", status: "completed", priority: "urgent", dueDate: DAY },
      { id: "low", title: "Later", status: "todo", priority: "low", dueDate: DAY },
      { id: "high", title: "First", status: "todo", priority: "high", dueDate: DAY },
      { id: "other", title: "Other day", status: "todo", priority: "urgent", dueDate: "2026-10-21" },
    ],
    DAY
  );
  assertEqual(plan.length, 3, "only the selected day");
  assertEqual(plan[0].id, "high", "open high-priority task leads");
  assertEqual(plan[0].isNext, true, "that task is next");
  assertEqual(plan.filter((item) => item.isNext).length, 1, "only one next task");
  assertEqual(plan[2].id, "done", "finished work follows the open work");
  assertEqual(plan[2].isNext, false, "a completed task is not next");
  assertEqual(primaryAction("todo").label, "Start", "todo starts");
  assert(primaryAction("todo").status !== "completed", "todo cannot be completed");
  assertEqual(primaryAction("in_progress").label, "Complete", "in progress can complete");
  assertEqual(primaryAction("in_review").label, "Complete", "in review can complete");
  assertEqual(primaryAction("blocked").label, "Resume", "blocked resumes");
  assert(primaryAction("blocked").status !== "completed", "blocked cannot be completed");
  assertEqual(primaryAction("completed").label, "Reopen", "completed reopens");
});

check("a session sits on its effective start, and a correction can move the day", () => {
  const view = buildDayView({
    dayKey: "2026-10-21",
    timeZone: ZONE,
    tasks: [{ id: "t1", title: "Notes", status: "todo", dueDate: DAY }],
    sessions: [
      {
        id: "s1",
        started_at: "2026-10-20T23:00:00Z",
        ended_at: "2026-10-20T23:30:00Z",
        duration_seconds: 1800,
        task_id: "t1",
      },
      {
        id: "s2",
        started_at: "2026-10-21T09:00:00Z",
        ended_at: "2026-10-21T09:10:00Z",
        duration_seconds: null,
        task_id: null,
      },
    ],
    corrections: [
      {
        session_id: "s1",
        corrected_started_at: "2026-10-21T01:00:00Z",
        corrected_ended_at: "2026-10-21T01:30:00Z",
        corrected_duration_seconds: 1800,
        created_at: "2026-10-21T02:00:00Z",
      },
    ],
  });
  assertEqual(view.journal.length, 2, "both sessions land on the 21st");
  assertEqual(view.journal[0].id, "s1", "the corrected session is earliest");
  assertEqual(view.journal[0].taskTitle, "Notes", "the task title is kept");
  assertEqual(view.journal[0].durationSeconds, 1800, "the corrected duration");
  assertEqual(view.journal[1].taskTitle, null, "no task stays unattributed");
  assertEqual(view.journal[1].unattributed, true, "unattributed flag");
  assertEqual(view.journal[1].durationSeconds, null, "a missing duration stays missing");
  assertEqual(durationText(null), "No time recorded", "missing duration text");
  assertEqual(durationText(1800), "30m", "recorded duration text");

  const previous = buildDayView({
    dayKey: DAY,
    timeZone: ZONE,
    tasks: [],
    sessions: view.journal.length ? [
      {
        id: "s1",
        started_at: "2026-10-20T23:00:00Z",
        ended_at: "2026-10-20T23:30:00Z",
        duration_seconds: 1800,
        task_id: "t1",
      },
    ] : [],
    corrections: [
      {
        session_id: "s1",
        corrected_started_at: "2026-10-21T01:00:00Z",
        corrected_ended_at: "2026-10-21T01:30:00Z",
        corrected_duration_seconds: 1800,
        created_at: "2026-10-21T02:00:00Z",
      },
    ],
  });
  assertEqual(previous.journal.length, 0, "the original day no longer holds the session");
});

check("a session in another timezone uses the view timezone", () => {
  const view = buildDayView({
    dayKey: "2026-10-20",
    timeZone: "America/New_York",
    tasks: [],
    sessions: [
      {
        id: "s1",
        startedAt: "2026-10-21T02:00:00Z",
        endedAt: "2026-10-21T03:00:00Z",
        durationSeconds: 3600,
        taskId: null,
      },
    ],
  });
  assertEqual(view.journal.length, 1, "22:00 in New York is still the 20th");
  const utc = buildDayView({
    dayKey: "2026-10-20",
    timeZone: "UTC",
    sessions: [
      {
        id: "s1",
        startedAt: "2026-10-21T02:00:00Z",
        endedAt: "2026-10-21T03:00:00Z",
        durationSeconds: 3600,
      },
    ],
  });
  assertEqual(utc.journal.length, 0, "the same instant is the 21st in UTC");
});

check("the week summary uses tasks due that week and sessions that start in it", () => {
  const view = buildDayView({
    dayKey: DAY,
    timeZone: ZONE,
    tasks: [
      {
        id: "in",
        title: "In week",
        status: "in_progress",
        priority: "medium",
        dueDate: "2026-10-22",
        estimatedSeconds: 3600,
      },
      {
        id: "out",
        title: "Out of week",
        status: "in_progress",
        dueDate: "2026-10-26",
        estimatedSeconds: 99999,
      },
    ],
    sessions: [
      {
        id: "in-session",
        startedAt: "2026-10-22T10:00:00Z",
        endedAt: "2026-10-22T10:30:00Z",
        durationSeconds: 1800,
        taskId: "in",
      },
      {
        id: "out-session",
        startedAt: "2026-10-26T10:00:00Z",
        endedAt: "2026-10-26T12:00:00Z",
        durationSeconds: 7200,
        taskId: "out",
      },
    ],
  });
  assertEqual(view.summary.totals.tasksInScope, 1, "the other week is excluded");
  assertEqual(view.summary.totals.sessionsInScope, 1, "the other week's session is excluded");
  assertEqual(view.summary.totals.plannedSeconds, 3600, "the plan is the in-week estimate");
  assertEqual(view.summary.totals.actualSeconds, 1800, "the recorded time is the in-week session");
  assertEqual(differenceText(view.summary.totals), "under by 30m", "the difference is a fact");
  assertEqual(plannedTotalText(view.summary.totals), "1h", "planned text");
  assertEqual(recordedTotalText(view.summary.totals), "30m", "recorded text");
});

check("a missing plan or a missing duration is not compared as zero", () => {
  const noEstimate = buildDayView({
    dayKey: DAY,
    timeZone: ZONE,
    tasks: [{ id: "t", title: "Open", status: "todo", dueDate: DAY, estimatedSeconds: null }],
    sessions: [
      {
        id: "s",
        startedAt: "2026-10-20T10:00:00Z",
        endedAt: "2026-10-20T11:00:00Z",
        durationSeconds: 3600,
        taskId: "t",
      },
    ],
  });
  assertEqual(plannedTotalText(noEstimate.summary.totals), "No plan recorded", "no estimate");
  assert(
    differenceText(noEstimate.summary.totals).startsWith("Not comparable"),
    "an incomplete plan is not a difference"
  );
  assert(!differenceText(noEstimate.summary.totals).includes("0s"), "no zero difference");

  const noDuration = buildDayView({
    dayKey: DAY,
    timeZone: ZONE,
    tasks: [{ id: "t", title: "Open", status: "in_progress", dueDate: DAY, estimatedSeconds: 3600 }],
    sessions: [
      {
        id: "s",
        startedAt: "2026-10-20T10:00:00Z",
        endedAt: "2026-10-20T11:00:00Z",
        durationSeconds: null,
        taskId: "t",
      },
    ],
  });
  assertEqual(recordedTotalText(noDuration.summary.totals), "No recorded time", "no duration");
  assert(
    differenceText(noDuration.summary.totals).includes("recorded time is incomplete"),
    "an unrecorded session is not zero"
  );

  const empty = buildDayView({ dayKey: DAY, timeZone: ZONE });
  assertEqual(recordedTotalText(empty.summary.totals), "Nothing recorded yet", "empty week");
  assertEqual(plannedTotalText(empty.summary.totals), "No tasks yet", "empty plan");
  assert(!recordedTotalText(empty.summary.totals).includes("0"), "empty is not zero");
});

check("work logs are not added to the journal or the week total", () => {
  const view = buildDayView({
    dayKey: DAY,
    timeZone: ZONE,
    tasks: [],
    sessions: [],
    logs: [{ id: "log", log_date: DAY, duration_seconds: 9999, title: "A work log" }],
  });
  assertEqual(view.journal.length, 0, "a work log is not a journal row");
  assertEqual(view.summary.totals.sessionsInScope, 0, "a work log is not recorded time");
  assertEqual(view.summary.totals.actualSeconds, 0, "the log duration is not added");
});

check("a day is marked only when it has a due task or a session", () => {
  const view = buildDayView({
    dayKey: DAY,
    timeZone: ZONE,
    tasks: [{ id: "t", title: "Due", status: "todo", dueDate: DAY }],
    sessions: [
      {
        id: "s",
        startedAt: "2026-10-22T08:00:00Z",
        endedAt: "2026-10-22T08:20:00Z",
        durationSeconds: 1200,
        taskId: null,
      },
    ],
  });
  const tuesday = view.marks.find((day) => day.key === DAY);
  const thursday = view.marks.find((day) => day.key === "2026-10-22");
  const friday = view.marks.find((day) => day.key === "2026-10-23");
  assertEqual(tuesday.label, "Plan", "a due task marks the day");
  assertEqual(thursday.label, "Recorded", "a session marks the day");
  assertEqual(friday.label, null, "an empty day has no mark");
  assertEqual(friday.hasTask, false, "no task");
  assertEqual(friday.hasSession, false, "no session");
});

check("a clock time on a civil day is that time in the timezone", () => {
  assertEqual(
    civilToInstant(DAY, "09:00", "UTC"),
    "2026-10-20T09:00:00.000Z",
    "09:00 UTC"
  );
  const newYork = civilToInstant(DAY, "09:00", "America/New_York");
  assertEqual(formatClock(newYork, "America/New_York"), "9:00 AM", "09:00 in New York");
  assertEqual(civilToInstant("2026-02-31", "09:00", "UTC"), null, "an impossible day is not a time");
  assertEqual(civilToInstant(DAY, "9am", "UTC"), null, "an unreadable clock is not a time");
});

check("the reminder is the newest unacknowledged in-app notification", () => {
  const reminder = pickReminder([
    {
      id: "old",
      channel: "in_app",
      status: "delivered",
      title: "Older",
      created_at: "2026-10-20T08:00:00Z",
    },
    {
      id: "acked",
      channel: "in_app",
      status: "acknowledged",
      title: "Done",
      created_at: "2026-10-20T12:00:00Z",
    },
    {
      id: "other",
      channel: "email",
      status: "sent",
      title: "Email",
      created_at: "2026-10-20T13:00:00Z",
    },
    {
      id: "new",
      channel: "in_app",
      status: "sent",
      title: "Standup",
      created_at: "2026-10-20T09:00:00Z",
    },
  ]);
  assertEqual(reminder.id, "new", "the newer open in-app notification");
  assertEqual(pickReminder([]), null, "no notifications means no reminder");
  assertEqual(
    pickReminder([{ id: "a", channel: "in_app", status: "acknowledged", title: "Done" }]),
    null,
    "an acknowledged notification is not an open reminder"
  );
});

check("a week streak counts recorded days back from today and skips a gap", () => {
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"].map(
    (key) => ({ key })
  );
  const active = new Set(["2026-10-19", "2026-10-20", "2026-10-21"]);
  assertEqual(streakInWeek(days, active, "2026-10-21"), 3, "today included");
  assertEqual(streakInWeek(days, active, "2026-10-22"), 3, "today empty still counts yesterday");
  assertEqual(streakInWeek(days, new Set(["2026-10-19"]), "2026-10-21"), 0, "a gap breaks the run");
  const keys = activeDayKeys({
    learning: [{ occurredAt: "2026-10-21T15:00:00.000Z", durationSeconds: 60 }],
    coding: [{ occurredAt: "2026-10-21T16:00:00.000Z", durationSeconds: null }],
    sessionDayKeys: ["2026-10-20"],
    timeZone: "UTC",
  });
  assert(keys.has("2026-10-21"), "learning with a duration counts");
  assert(keys.has("2026-10-20"), "a session day counts");
  assertEqual(keys.size, 2, "a missing coding duration does not add a day");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
