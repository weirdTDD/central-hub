// The tracking page is one day's recorded time, laid out as a schedule.
//
// Each row is a session placed at its effective start. A task has no clock, so
// the timeline never invents an hour for one. The plus button records a manual
// session; it does not create an appointment that was not entered.

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import AppShell from "../../components/AppShell";
import Plan from "../../components/Plan";
import { systemTimeZone } from "../../lib/dates";
import {
  durationStringToSeconds,
  isParseableDuration,
} from "../../dashboard/logUtils";
import {
  civilToInstant,
  durationText,
  formatClock,
  formatDayHeading,
  sessionsForDay,
  tasksForDay,
  todayKey,
  weekWindow,
} from "../../dashboard/todayView";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useTracking } from "./TrackingContext";

const UNATTRIBUTED = "unattributed";
import { buildProgressTree } from "./progressTree.js";

export default function TrackingPage() {
  const {
    sessions,
    corrections,
    taskReferences,
    loading,
    error,
    actionError,
    isConfigured,
    truncated,
    correctionsTruncated,
    busy,
    addManualSession,
  } = useTracking();

  const timeZone = useMemo(() => systemTimeZone(), []);
  const today = useMemo(() => todayKey(timeZone), [timeZone]);
  const [dayKey, setDayKey] = useState(today);
  const [adding, setAdding] = useState(false);
  const [startTime, setStartTime] = useState("");
  const [duration, setDuration] = useState("");
  const [taskId, setTaskId] = useState("");
  const [formError, setFormError] = useState("");

  const week = weekWindow(dayKey);
  const entries = useMemo(
    () =>
      sessionsForDay({
        sessions,
        corrections,
        tasks: taskReferences,
        dayKey,
        timeZone,
      }),
    [sessions, corrections, taskReferences, dayKey, timeZone]
  );
  const recordedDays = useMemo(() => {
    const days = new Set();
    for (const day of week?.days ?? []) {
      const count = sessionsForDay({
        sessions,
        corrections,
        tasks: taskReferences,
        dayKey: day.key,
        timeZone,
      }).length;
      if (count > 0) days.add(day.key);
    }
    return days;
  }, [week, sessions, corrections, taskReferences, timeZone]);

  const gaps = useMemo(
    () =>
      buildProgressTree({
        tasks: taskReferences,
        sessions,
        corrections,
      }).weakSpots,
    [taskReferences, sessions, corrections]
  );

  const applications = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.application])),
    [sessions]
  );

  const dayPlan = useMemo(
    () => tasksForDay(taskReferences, dayKey),
    [taskReferences, dayKey]
  );
  const planState = !isConfigured ? "unconfigured" : loading ? "loading" : error ? "error" : "ready";

  const headingDate = formatDayHeading(dayKey);
  const heading =
    dayKey === today ? "Today" : headingDate.split(",")[0] || headingDate;
  const dateLine = headingDate.replace(/^[^,]+,\s*/, "");

  const saveSession = async (event) => {
    event.preventDefault();
    setFormError("");
    if (!startTime) {
      setFormError("A start time is required.");
      return;
    }
    if (!duration.trim() || !isParseableDuration(duration)) {
      setFormError('Duration must be a length such as "30m" or "1h 15m".');
      return;
    }
    const startedAt = civilToInstant(dayKey, startTime, timeZone);
    const durationSeconds = durationStringToSeconds(duration);
    if (!startedAt || durationSeconds === null) {
      setFormError("That start time could not be read.");
      return;
    }
    const result = await addManualSession({
      startedAt,
      durationSeconds,
      taskId: taskId || null,
    });
    if (!result.ok) {
      setFormError(result.error || "The session could not be saved.");
      return;
    }
    setStartTime("");
    setDuration("");
    setTaskId("");
    setAdding(false);
  };

  return (
    <AppShell currentPath="/tracking" className="pb-28">
        <div className="mx-auto flex max-w-lg flex-col gap-6">
          <header>
            <p className="text-sm text-muted-foreground">{dateLine}</p>
            <h1 className="mt-1 text-4xl font-bold tracking-tight">{heading}</h1>
            <p className="mt-1 text-xs text-muted-foreground">Times follow {timeZone}.</p>
          </header>

          <nav aria-label="Week" className="-mx-4 px-1 sm:mx-0 sm:px-0">
            <div className="grid grid-cols-7">
              {(week?.days ?? []).map((day) => {
                const selected = day.key === dayKey;
                const recorded = recordedDays.has(day.key);
                return (
                  <button
                    key={day.key}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${day.weekday} ${day.dayNumber}${recorded ? ", Recorded" : ""}`}
                    onClick={() => setDayKey(day.key)}
                    className={`flex min-h-11 flex-col items-center justify-center rounded-2xl px-0.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selected ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <span className="text-[11px] font-medium">{day.weekday}</span>
                    <span className={`text-sm font-semibold ${selected ? "text-primary" : "text-foreground"}`}>
                      {day.dayNumber}
                    </span>
                    <span
                      className={`mt-0.5 h-1.5 w-1.5 rounded-full ${selected ? "bg-primary" : "bg-transparent"}`}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </nav>

          {truncated || correctionsTruncated ? (
            <p role="status" className="text-sm text-muted-foreground">
              Showing the most recent records. Older sessions are not on this timeline.
            </p>
          ) : null}

          {error ? (
            <div role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
              <p className="font-semibold">Could not load tracking</p>
              <p className="mt-1">{error}</p>
            </div>
          ) : null}

          {!isConfigured ? (
            <div role="status" className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
              <p className="font-semibold">Not connected</p>
              <p className="mt-1 text-muted-foreground">Configure Supabase to load recorded time.</p>
            </div>
          ) : null}

          <Plan
            items={dayPlan}
            state={planState}
            error={error || ""}
            headerTo="/tasks"
            headerLabel="Tasks"
          />

          <section aria-label="Recorded time">
            {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {!loading && isConfigured && !error && entries.length === 0 ? (
              <p className="rounded-2xl bg-muted px-4 py-6 text-sm text-muted-foreground">
                No time recorded on this day.
              </p>
            ) : null}
            {entries.length > 0 ? (
              <ol className="relative space-y-3 border-l border-border pl-5">
                {entries.map((entry, index) => {
                  const latest = index === entries.length - 1;
                  const clock = formatClock(entry.startedAt, timeZone);
                  const application = applications.get(entry.id);
                  const title = entry.unattributed ? "Unattributed" : entry.taskTitle || "Untitled task";
                  const detail = [durationText(entry.durationSeconds), application]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <li key={entry.id} className="relative">
                      <span
                        className={`absolute top-5 -left-[26px] h-3 w-3 rounded-full border-2 ${
                          latest ? "border-primary bg-primary" : "border-primary/40 bg-background"
                        }`}
                        aria-hidden="true"
                      />
                      <article
                        className={`rounded-2xl px-4 py-3 ${
                          latest ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <h2 className="text-sm font-semibold">{title}</h2>
                          <p className="shrink-0 text-sm font-medium">{clock ?? "No start time"}</p>
                        </div>
                        {latest ? <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide">Latest</p> : null}
                        <p className={`mt-1 text-xs ${latest ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                          {detail}
                        </p>
                      </article>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>

          {!loading && gaps.length > 0 ? (
            <section aria-label="Gaps" className="rounded-2xl border border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Gaps</h2>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {gaps.map((spot) => (
                  <li key={spot.id}>
                    <span className="font-medium text-foreground">{spot.reason}.</span> {spot.title}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {adding ? (
            <form onSubmit={saveSession} className="rounded-2xl border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Record time</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                On {headingDate}. A session with no task stays unattributed.
              </p>
              {formError || actionError ? (
                <p role="alert" className="mt-2 text-sm text-destructive">{formError || actionError}</p>
              ) : null}
              <div className="mt-3 grid gap-3">
                <div>
                  <label htmlFor="session-task" className="text-xs font-medium text-muted-foreground">Task</label>
                  <Select
                    value={taskId || UNATTRIBUTED}
                    onValueChange={(value) => setTaskId(value === UNATTRIBUTED ? "" : value)}
                  >
                    <SelectTrigger id="session-task" className="mt-1" aria-label="Task">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNATTRIBUTED}>Unattributed</SelectItem>
                      {taskReferences.map((task) => (
                        <SelectItem key={task.id} value={task.id}>{task.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="session-start" className="text-xs font-medium text-muted-foreground">Start</label>
                    <input
                      id="session-start"
                      type="time"
                      value={startTime}
                      onChange={(event) => setStartTime(event.target.value)}
                      className="mt-1 block min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <div>
                    <label htmlFor="session-duration" className="text-xs font-medium text-muted-foreground">Duration</label>
                    <input
                      id="session-duration"
                      value={duration}
                      onChange={(event) => setDuration(event.target.value)}
                      placeholder="30m"
                      className="mt-1 block min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busy || !isConfigured}
                  className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          ) : null}
        </div>

        <button
          type="button"
          aria-expanded={adding}
          onClick={() => {
            setAdding((open) => !open);
            setFormError("");
          }}
          className="fixed bottom-6 left-1/2 z-20 inline-flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:left-[calc(50%+9rem)]"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
          <span className="sr-only">{adding ? "Close the session form" : "Record time"}</span>
        </button>
    </AppShell>
  );
}
