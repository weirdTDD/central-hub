import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Bell } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { systemTimeZone } from "../lib/dates";
import { isSupabaseConfigured } from "../lib/supabase";
import { listNotifications } from "../lib/notifications";
import { insertTask, listTasks, updateTask } from "../lib/tasks";
import { listRecentCorrections, listSessions } from "../lib/tracking";
import { isValidStatusTransition } from "../features/tasks/taskUtils";
import CodingDayCard from "../features/coding/CodingDayCard";
import LearningDayCard from "../features/learning/LearningDayCard";
import AppShell from "../components/AppShell";
import Plan from "../components/Plan";
import Queue from "../components/Queue";
import {
  durationStringToSeconds,
  isParseableDuration,
} from "./logUtils";
import {
  buildDayView,
  differenceText,
  durationText,
  formatClock,
  formatDayHeading,
  greetingFor,
  personName,
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
    <div role={role} className={`rounded-2xl border px-4 py-3 text-sm ${toneClass}`}>
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
  const timeZone = useMemo(() => systemTimeZone(), []);
  const [dayKey, setDayKey] = useState(() => todayKey(systemTimeZone()));
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
  const marksKnown = tasks.status === "ready" && sessions.status === "ready" && corrections.status === "ready";
  const name = personName(user);
  const greeting = greetingFor(new Date(), timeZone);
  const heading = name ? `${greeting}, ${name}` : greeting;

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
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{heading}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{formatDayHeading(dayKey)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Days follow {timeZone}.</p>
            </div>
            <Link
              to="/logs"
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Work logs
            </Link>
          </header>

          <nav aria-label="Week" className="-mx-4 px-1 sm:mx-0 sm:px-0">
            <div className="grid grid-cols-7">
              {(marksKnown ? view.marks : week?.days ?? []).map((day) => {
                const selected = day.key === dayKey;
                const label = marksKnown ? day.label : null;
                return (
                  <button
                    key={day.key}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${day.weekday} ${day.dayNumber}${
                      label ? `, ${label}` : marksKnown ? ", nothing due or recorded" : ""
                    }`}
                    onClick={() => setDayKey(day.key)}
                    className={`flex min-h-11 flex-col items-center justify-center rounded-2xl px-0.5 py-1.5 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground hover:bg-card"
                    }`}
                  >
                    <span className="text-[10px] font-medium uppercase tracking-wide">{day.weekday}</span>
                    <span className="text-sm font-semibold leading-none">{day.dayNumber}</span>
                    <span className={`mt-1 text-[9px] leading-tight ${label ? "" : "invisible"}`} aria-hidden={label ? undefined : true}>
                      {label ?? "—"}
                    </span>
                  </button>
                );
              })}
            </div>
          </nav>

          {truncated.length > 0 ? (
            <div role="status" className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
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

          <div className="grid gap-6 md:grid-cols-2">
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
                <div className="mt-3 grid gap-3">
                  <div className="min-w-0">
                    <label htmlFor="day-task-title" className="text-xs font-medium text-muted-foreground">
                      Title
                    </label>
                    <input
                      id="day-task-title"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      className="mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="What is due?"
                    />
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                    <div className="min-w-0">
                      <label htmlFor="day-task-estimate" className="text-xs font-medium text-muted-foreground">
                        Estimate
                      </label>
                      <input
                        id="day-task-estimate"
                        value={estimate}
                        onChange={(event) => setEstimate(event.target.value)}
                        className="mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder="30m"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={saving || !isSupabaseConfigured}
                      className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    >
                      {saving ? "Adding…" : "Add"}
                    </button>
                  </div>
                </div>
              </form>
              }
            />

            <section aria-labelledby="journal-heading" className="rounded-3xl border border-border bg-card p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 id="journal-heading" className="text-lg font-semibold">Journal</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recorded sessions that start this day.
                  </p>
                </div>
                <Link
                  to="/tracking"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Tracking
                </Link>
              </div>
              <div className="mt-4">
                {journalState === "unconfigured" ? (
                  <Block title="Not connected" detail="Configure Supabase to load recorded time." />
                ) : null}
                {journalState === "loading" ? (
                  <Block title="Loading…" detail="Loading sessions for this day." />
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
                  <ol className="space-y-3">
                    {view.journal.map((entry) => {
                      const clock = formatClock(entry.startedAt, timeZone);
                      return (
                        <li key={entry.id} className="rounded-2xl border border-border bg-background px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
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

function Reminder({ state, error, reminder }) {
  return (
    <section aria-labelledby="reminder-heading" className="rounded-3xl border border-primary/20 bg-primary/10 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="reminder-heading" className="text-sm font-semibold">Reminder</h2>
          {state === "unconfigured" ? (
            <p className="mt-1 text-sm text-muted-foreground">Not connected. Configure Supabase to load reminders.</p>
          ) : null}
          {state === "loading" ? <p className="mt-1 text-sm text-muted-foreground">Loading reminders…</p> : null}
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
              className="mt-3 inline-flex min-h-11 items-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  return (
    <section aria-labelledby="week-heading" className="rounded-3xl border border-border bg-card p-4 sm:p-5">
      <h2 id="week-heading" className="text-lg font-semibold">This week</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {range ? `${range}. ` : ""}
        Planned time is the estimate of open tasks due this week. Recorded time is sessions that start this week.
      </p>
      {state === "unconfigured" ? (
        <p className="mt-3 text-sm text-muted-foreground">Not connected. Configure Supabase to compare the week.</p>
      ) : null}
      {state === "loading" ? <p className="mt-3 text-sm text-muted-foreground">Loading the week…</p> : null}
      {state === "error" ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{error || "Could not compare this week."}</p>
      ) : null}
      {state === "ready" ? (
        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-muted px-3 py-3">
            <dt className="text-xs font-medium text-muted-foreground">Planned</dt>
            <dd className="mt-1 text-lg font-semibold">{plannedTotalText(totals)}</dd>
          </div>
          <div className="rounded-2xl bg-progress/10 px-3 py-3">
            <dt className="text-xs font-medium text-muted-foreground">Recorded</dt>
            <dd className="mt-1 text-lg font-semibold">{recordedTotalText(totals)}</dd>
          </div>
          <div className="rounded-2xl bg-muted px-3 py-3">
            <dt className="text-xs font-medium text-muted-foreground">Difference</dt>
            <dd className="mt-1 text-lg font-semibold">{differenceText(totals)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
