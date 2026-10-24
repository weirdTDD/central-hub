import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bell } from "lucide-react";
import { Skeleton } from "../components/ui/skeleton";
import { useAuth } from "../auth/AuthContext";
import { localDayKey, systemTimeZone } from "../lib/dates";
import { isSupabaseConfigured } from "../lib/supabase";
import { listNotifications } from "../lib/notifications";
import { insertTask, listTasks, updateTask } from "../lib/tasks";
import { listRecentCorrections, listSessions } from "../lib/tracking";
import { isValidStatusTransition } from "../features/tasks/taskUtils";
import CodingDayCard from "../features/coding/CodingDayCard";
import LearningDayCard from "../features/learning/LearningDayCard";
import AppShell from "../components/AppShell";
import HomeBoard from "./HomeBoard";
import Plan from "../components/Plan";
import Queue from "../components/Queue";
import {
  durationStringToSeconds,
  formatDurationFromSeconds,
  isParseableDuration,
} from "./logUtils";
import { hoursGradeFromSeconds, hoursGradeSurface } from "../lib/hoursGrade";
import {
  buildDayView,
  differenceText,
  durationText,
  formatClock,
  formatDayHeading,
  plannedTotalText,
  primaryAction,
  recordedTotalText,
  todayKey,
  weekWindow,
  workQueue,
} from "./todayView";

const UNCONFIGURED = { status: "unconfigured", rows: [], truncated: false, error: "" };
const LOADING = { status: "loading", rows: [], truncated: false, error: "" };

function fromSettled(result) {
  if (result.status === "fulfilled") {
    const value = result.value ?? {};
    return {
      status: "ready",
      rows: value.rows ?? [],
      truncated: Boolean(value.truncated),
      error: "",
    };
  }
  return {
    status: "error",
    rows: [],
    truncated: false,
    error: result.reason?.message || "Could not load this.",
  };
}

function Block({ role = "status", title, detail, tone = "neutral" }) {
  const toneClass =
    tone === "error"
      ? "border-destructive/40 bg-destructive/5"
      : "border-border bg-card";
  return (
    <div role={role} className={`rounded-xl border px-3 py-2 text-sm ${toneClass}`}>
      <p className="font-semibold text-foreground">{title}</p>
      {detail ? <p className="mt-1 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function sectionState(parts) {
  if (parts.some((part) => part.status === "unconfigured")) return "unconfigured";
  if (parts.some((part) => part.status === "loading")) return "loading";
  if (parts.some((part) => part.status === "error")) return "error";
  return "ready";
}

function errorDetail(parts) {
  return parts
    .filter((part) => part.status === "error" && part.error)
    .map((part) => part.error)
    .join(" ");
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const timeZone = useMemo(() => systemTimeZone(), []);
  const queryDay = searchParams.get("day");
  const [fallbackDayKey, setFallbackDayKey] = useState(() => todayKey(systemTimeZone()));
  const dayKey = isDayKey(queryDay) ? queryDay : fallbackDayKey;
  const [reloadKey, setReloadKey] = useState(0);
  const [tasks, setTasks] = useState(isSupabaseConfigured ? LOADING : UNCONFIGURED);
  const [sessions, setSessions] = useState(isSupabaseConfigured ? LOADING : UNCONFIGURED);
  const [corrections, setCorrections] = useState(isSupabaseConfigured ? LOADING : UNCONFIGURED);
  const [notifications, setNotifications] = useState(isSupabaseConfigured ? LOADING : UNCONFIGURED);
  const [title, setTitle] = useState("");
  const [estimate, setEstimate] = useState("");
  const [formError, setFormError] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;

    let active = true;
    Promise.allSettled([
      listTasks(),
      listSessions(),
      listRecentCorrections(),
      listNotifications(),
    ]).then(([taskResult, sessionResult, correctionResult, notificationResult]) => {
      if (!active) return;
      setTasks(fromSettled(taskResult));
      setSessions(fromSettled(sessionResult));
      setCorrections(fromSettled(correctionResult));
      setNotifications(fromSettled(notificationResult));
    });

    return () => {
      active = false;
    };
  }, [reloadKey]);

  const week = weekWindow(dayKey);
  const view = useMemo(
    () =>
      buildDayView({
        dayKey,
        timeZone,
        tasks: tasks.status === "ready" ? tasks.rows : [],
        sessions: sessions.status === "ready" ? sessions.rows : [],
        corrections: corrections.status === "ready" ? corrections.rows : [],
        notifications: notifications.status === "ready" ? notifications.rows : [],
      }),
    [dayKey, timeZone, tasks, sessions, corrections, notifications]
  );

  const queue = useMemo(
    () => workQueue(tasks.status === "ready" ? tasks.rows : []).slice(0, 5),
    [tasks]
  );
  const planState = sectionState([tasks]);
  const journalState = sectionState([tasks, sessions, corrections]);
  const summaryState = sectionState([tasks, sessions, corrections]);
  const reminderState = sectionState([notifications]);
  const today = useMemo(() => todayKey(timeZone), [timeZone]);

  const selectDay = (nextDay) => {
    setFallbackDayKey(nextDay);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("day", nextDay);
    setSearchParams(nextParams, { replace: true });
  };

  const dayTasks = tasks.status === "ready" ? tasks.rows.filter((task) => (task.dueDate ?? task.due_date) === dayKey) : [];
  const completedTasks = dayTasks.filter((task) => task.status === "completed").length;
  const daySessions = sessions.status === "ready"
    ? sessions.rows.filter((session) => {
        const startedAt = session.startedAt ?? session.started_at;
        return startedAt && localDayKey(startedAt, timeZone) === dayKey;
      })
    : [];
  const recordedSeconds = daySessions.reduce((sum, session) => {
    const duration = session.durationSeconds ?? session.duration_seconds;
    return sum + (duration == null ? 0 : Number(duration));
  }, 0);
  const hasRecordedDuration = daySessions.some((session) => (session.durationSeconds ?? session.duration_seconds) != null);
  const sessionsWithoutDuration = daySessions.filter((session) => (session.durationSeconds ?? session.duration_seconds) == null).length;
  const plannedSeconds = dayTasks.reduce((sum, task) => {
    const estimate = task.estimatedSeconds ?? task.estimated_duration_seconds;
    return sum + (estimate == null ? 0 : Number(estimate));
  }, 0);
  const hasEstimate = dayTasks.some((task) => (task.estimatedSeconds ?? task.estimated_duration_seconds) != null);
  const tasksWithoutEstimate = dayTasks.filter((task) => (task.estimatedSeconds ?? task.estimated_duration_seconds) == null).length;
  const daySummaryState = sectionState([tasks, sessions]);

  const addTask = async (event) => {
    event.preventDefault();
    setFormError("");
    if (!title.trim()) {
      setFormError("Title is required.");
      return;
    }
    if (estimate.trim() && !isParseableDuration(estimate)) {
      setFormError('Estimate must be a duration such as "30m" or "1h 15m".');
      return;
    }
    setSaving(true);
    try {
      await insertTask({
        title,
        dueDate: dayKey,
        estimatedSeconds: estimate.trim() ? durationStringToSeconds(estimate) : null,
      });
      setTitle("");
      setEstimate("");
      setReloadKey((value) => value + 1);
    } catch (error) {
      setFormError(error?.message || "Could not add this task.");
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (task) => {
    const action = primaryAction(task.status);
    if (!action || !isValidStatusTransition(task.status, action.status)) {
      setActionError("That change is not allowed.");
      return;
    }
    setActionError("");
    setBusyId(task.id);
    const completedAt =
      action.status === "completed"
        ? new Date().toISOString()
        : action.status === "todo"
          ? null
          : undefined;
    try {
      await updateTask(task.id, {
        status: action.status,
        ...(completedAt !== undefined ? { completedAt } : {}),
      });
      setReloadKey((value) => value + 1);
    } catch (error) {
      setActionError(error?.message || "Could not update this task.");
    } finally {
      setBusyId(null);
    }
  };

  const truncated = [
    tasks.truncated ? "tasks" : null,
    sessions.truncated ? "sessions" : null,
    corrections.truncated ? "corrections" : null,
    notifications.truncated ? "notifications" : null,
  ].filter(Boolean);

  return (
    <AppShell currentPath="/dashboard">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <HomeBoard
            user={user}
            dayKey={dayKey}
            today={today}
            timeZone={timeZone}
            days={week?.days ?? []}
            onSelectDay={selectDay}
            plan={planState === "ready" ? view.plan : []}
            planState={planState}
            sessionDayKeys={(view.marks ?? []).filter((day) => day.hasSession).map((day) => day.key)}
          />

          <DaySummary
            state={daySummaryState}
            error={errorDetail([tasks, sessions])}
            dayTasks={dayTasks}
            completedTasks={completedTasks}
            recorded={hasRecordedDuration ? formatDurationFromSeconds(recordedSeconds) : "No time recorded"}
            recordedDetail={sessionsWithoutDuration ? `${sessionsWithoutDuration} session${sessionsWithoutDuration === 1 ? " has" : "s have"} no recorded duration.` : null}
            planned={hasEstimate ? formatDurationFromSeconds(plannedSeconds) : "No estimate"}
            plannedDetail={tasksWithoutEstimate ? `${tasksWithoutEstimate} task${tasksWithoutEstimate === 1 ? " has" : "s have"} no estimate.` : null}
          />

          {truncated.length > 0 ? (
            <div role="status" className="rounded-xl border border-border bg-card-gold px-3 py-2 text-sm shadow-sm">
              <p className="font-semibold">Showing the most recent records</p>
              <p className="mt-1 text-muted-foreground">
                The loaded {truncated.join(", ")} are incomplete. Older records are not
                included, and a session whose task was not loaded is shown as unattributed.
              </p>
            </div>
          ) : null}

          <Reminder state={reminderState} error={errorDetail([notifications])} reminder={view.reminder} />

          <WeekSummary
            state={summaryState}
            error={errorDetail([tasks, sessions, corrections])}
            totals={view.summary.totals}
            startKey={week?.startKey}
            endKey={week?.endKey}
          />

          <CodingDayCard dayKey={dayKey} timeZone={timeZone} />
          <LearningDayCard dayKey={dayKey} timeZone={timeZone} />

          <Queue
            items={queue}
            state={planState}
            error={errorDetail([tasks])}
            actionError={actionError}
            busyId={busyId}
            onAction={changeStatus}
            headerTo="/tasks"
            headerLabel="Tasks"
          />

          <div className="grid gap-4 md:grid-cols-2">
            <Plan
              items={view.plan}
              state={planState}
              error={errorDetail([tasks])}
              actionError={actionError}
              busyId={busyId}
              onAction={changeStatus}
              headerTo="/tasks"
              headerLabel="Tasks"
              footer={
              <form onSubmit={addTask} className="mt-5 border-t border-border pt-4">
                <h3 className="text-sm font-semibold">Add to this day</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Due {formatDayHeading(dayKey)}. No start time is set.
                </p>
                {formError ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">{formError}</p>
                ) : null}
                <div className="mt-3 grid gap-2">
                  <div className="min-w-0">
                    <label htmlFor="day-task-title" className="text-xs font-medium text-muted-foreground">
                      Title
                    </label>
                    <input
                      id="day-task-title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      className="mt-1 block min-h-9 w-full min-w-0 rounded-xl border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="What is due?"
                    />
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                    <div className="min-w-0">
                      <label htmlFor="day-task-estimate" className="text-xs font-medium text-muted-foreground">
                        Estimate
                      </label>
                      <input
                        id="day-task-estimate"
                        value={estimate}
                        onChange={(event) => setEstimate(event.target.value)}
                        className="mt-1 block min-h-9 w-full min-w-0 rounded-xl border border-border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="30m"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={saving || !isSupabaseConfigured}
                      className="inline-flex min-h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    >
                      {saving ? "Adding…" : "Add"}
                    </button>
                  </div>
                </div>
              </form>
              }
            />

            <section aria-labelledby="journal-heading" className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 id="journal-heading" className="text-base font-semibold">Journal</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recorded sessions that start this day.
                  </p>
                </div>
                <Link
                  to="/tracking"
                  className="inline-flex min-h-9 items-center justify-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Tracking
                </Link>
              </div>
              <div className="mt-3">
                {journalState === "unconfigured" ? (
                  <Block title="Not connected" detail="Configure Supabase to load recorded time." />
                ) : null}
                {journalState === "loading" ? (
                  <div className="mt-3 space-y-2">
                    <Skeleton className="h-4 w-1/3 mb-1" />
                    <Skeleton className="h-8 w-full mb-2" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                ) : null}
                {journalState === "error" ? (
                  <Block
                    role="alert"
                    tone="error"
                    title="Could not load the journal"
                    detail={errorDetail([tasks, sessions, corrections])}
                  />
                ) : null}
                {journalState === "ready" && view.journal.length === 0 ? (
                  <Block title="No time recorded" detail="No session starts on this day." />
                ) : null}
                {journalState === "ready" && view.journal.length > 0 ? (
                  <ol className="space-y-2">
                    {view.journal.map((entry) => {
                      const clock = formatClock(entry.startedAt, timeZone);
                      return (
                        <li key={entry.id} className="rounded-xl border border-border bg-background px-2.5 py-2">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-xs font-semibold text-primary">
                                {clock ?? "No start time"}
                              </p>
                              <h3 className="mt-1 text-sm font-semibold">
                                {entry.unattributed ? "Unattributed" : entry.taskTitle}
                              </h3>
                            </div>
                            <p className="text-sm text-muted-foreground">{durationText(entry.durationSeconds)}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </div>
            </section>
          </div>
        </div>
    </AppShell>
  );
}

function isDayKey(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function DaySummary({ state, error, dayTasks, completedTasks, recorded, recordedDetail, planned, plannedDetail }) {
  return (
    <section aria-labelledby="day-summary-heading" className="rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
      <h2 id="day-summary-heading" className="text-base font-semibold">Day summary</h2>
      {state === "unconfigured" ? <Block title="Not connected" detail="Configure Supabase to load this day’s tasks and sessions." /> : null}
      {state === "loading" ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-background px-2.5 py-2">
            <Skeleton className="h-4 w-24 mb-1" />
            <Skeleton className="h-8 w-full mb-2" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="rounded-xl border border-border bg-background px-2.5 py-2">
            <Skeleton className="h-4 w-24 mb-1" />
            <Skeleton className="h-8 w-full mb-2" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="rounded-xl border border-border bg-background px-2.5 py-2">
            <Skeleton className="h-4 w-24 mb-1" />
            <Skeleton className="h-8 w-full mb-2" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      ) : null}
      {state === "error" ? <div className="mt-3"><Block role="alert" tone="error" title="Could not load the day summary" detail={error} /></div> : null}
      {state === "ready" ? (
        dayTasks.length === 0 && recorded === "No time recorded" ? (
          <p className="mt-2 text-sm text-muted-foreground">No tasks or recorded time for this day.</p>
        ) : (
          <dl className="mt-3 grid gap-2 sm:grid-cols-3">
            <SummaryMetric label="Tasks due" value={`${completedTasks} / ${dayTasks.length} completed`} />
            <SummaryMetric label="Recorded today" value={recorded} detail={recordedDetail} />
            <SummaryMetric label="Planned today" value={planned} detail={plannedDetail} />
          </dl>
        )
      ) : null}
    </section>
  );
}

function SummaryMetric({ label, value, detail }) {
  return <div className="rounded-xl border border-border bg-background px-2.5 py-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold">{value}</dd>{detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}</div>;
}

function Reminder({ state, error, reminder }) {
  return (
    <section aria-labelledby="reminder-heading" className="rounded-xl border border-border bg-card-gold p-3 shadow-sm sm:p-4">
      <div className="flex items-start gap-2">
        <Bell className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="reminder-heading" className="text-sm font-semibold">Reminder</h2>
          {state === "unconfigured" ? (
            <p className="mt-1 text-sm text-muted-foreground">Not connected. Configure Supabase to load reminders.</p>
          ) : null}
          {state === "loading" ? (
            <div className="mt-3 flex flex-col gap-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full mb-1" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : null}
          {state === "error" ? (
            <p role="alert" className="mt-1 text-sm text-destructive">{error || "Could not load reminders."}</p>
          ) : null}
          {state === "ready" && reminder ? (
            <>
              <p className="mt-1 font-semibold">{reminder.title || "Untitled reminder"}</p>
              {reminder.body ? <p className="mt-1 text-sm text-muted-foreground">{reminder.body}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">Status: {reminder.status}</p>
            </>
          ) : null}
          {state === "ready" && !reminder ? (
            <p className="mt-1 text-sm text-muted-foreground">A reminder has not been set.</p>
          ) : null}
          {state === "ready" || state === "unconfigured" ? (
            <Link
              to="/notifications"
              className="mt-2 inline-flex min-h-9 items-center rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {state === "ready" && reminder
                ? "Open notifications"
                : state === "ready"
                  ? "Set a reminder"
                  : "Notifications"}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WeekSummary({ state, error, totals, startKey, endKey }) {
  const range =
    startKey && endKey
      ? `${formatDayHeading(startKey)} – ${formatDayHeading(endKey)}`
      : "";
  const recordedGrade = hoursGradeFromSeconds(
    totals?.actualSeconds && totals.sessionsInScope > 0
      ? totals.actualSeconds / 7
      : 0
  );
  return (
    <section aria-labelledby="week-heading" className="rounded-xl border border-border bg-card-mist p-3 shadow-sm sm:p-4">
      <h2 id="week-heading" className="text-base font-semibold">This week</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {range ? `${range}. ` : ""}
        Planned time is the estimate of open tasks due this week. Recorded time is sessions that start this week.
      </p>
      {state === "unconfigured" ? (
        <p className="mt-2 text-sm text-muted-foreground">Not connected. Configure Supabase to compare the week.</p>
      ) : null}
      {state === "loading" ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-background px-2.5 py-2 shadow-sm">
            <Skeleton className="h-4 w-24 mb-1" />
            <Skeleton className="h-6 w-full mb-1" />
          </div>
          <div className="rounded-xl border border-border bg-background px-2.5 py-2 shadow-sm">
            <Skeleton className="h-4 w-24 mb-1" />
            <Skeleton className="h-6 w-full mb-1" />
          </div>
          <div className="rounded-xl border border-border bg-background px-2.5 py-2 shadow-sm">
            <Skeleton className="h-4 w-24 mb-1" />
            <Skeleton className="h-6 w-full mb-1" />
          </div>
        </div>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="mt-2 text-sm text-destructive">{error || "Could not compare this week."}</p>
      ) : null}
      {state === "ready" ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-card-gold px-2.5 py-2 shadow-sm">
            <dt className="text-xs font-medium text-foreground/70">Planned</dt>
            <dd className="mt-1 text-lg font-semibold">{plannedTotalText(totals)}</dd>
          </div>
          <div className={`rounded-xl border border-border px-2.5 py-2 shadow-sm ${hoursGradeSurface(recordedGrade)}`}>
            <dt className="text-xs font-medium text-foreground/70">Recorded</dt>
            <dd className="mt-1 text-lg font-semibold">{recordedTotalText(totals)}</dd>
          </div>
          <div className={`rounded-xl border border-border px-2.5 py-2 shadow-sm ${differenceSurface(totals)}`}>
            <dt className="text-xs font-medium text-foreground/70">Difference</dt>
            <dd className="mt-1 text-lg font-semibold">{differenceText(totals)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

function differenceSurface(totals) {
  if (
    !totals ||
    totals.sessionsInScope === 0 ||
    totals.sessionsWithoutDuration > 0 ||
    totals.openTasksWithoutEstimate > 0 ||
    totals.plannedSeconds === 0
  ) {
    return "bg-muted";
  }
  const difference = totals.actualSeconds - totals.plannedSeconds;
  if (difference < 0) return "bg-heat-1";
  if (difference > 0) return "bg-heat-4";
  return "bg-heat-3";
}
