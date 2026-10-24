// One day's learning time, grouped into sessions by site and course.
//
// The numbers come from learning heartbeats (observations with activity_kind
// learning). They are not added to work logs, manual sessions, or coding time.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import AppShell from "../../components/AppShell";
import { Skeleton } from "../../components/ui/skeleton";
import { formatDurationFromSeconds } from "../../dashboard/logUtils";
import {
  durationText,
  formatClock,
  formatDayHeading,
  todayKey,
  weekWindow,
} from "../../dashboard/todayView";
import {
  coveredSeconds,
  foldHeartbeats,
  groupedCoveredSeconds,
  heartbeatsFromRows,
} from "../../../extensions/learning-tracker/lib/learningTime.js";
import { LEARNING_PROVIDER } from "../../../extensions/learning-tracker/lib/sites.js";
import { localDayKey, systemTimeZone } from "../../lib/dates";
import { getIntegrationByProvider } from "../../lib/integrations";
import { isSupabaseConfigured } from "../../lib/supabase";
import { deleteLearningObservations, listLearningObservations } from "../../lib/tracking";
import { ShareBars, WeekChart } from "../progress/Bars.jsx";
import { localDayRange } from "../coding/range.js";
import TrackedSitesPanel from "./TrackedSitesPanel.jsx";

export default function LearningPage() {
  const timeZone = useMemo(() => systemTimeZone(), []);
  const today = useMemo(() => todayKey(timeZone), [timeZone]);
  const [dayKey, setDayKey] = useState(today);
  const [reloadKey, setReloadKey] = useState(0);
  const week = weekWindow(dayKey);
  const weekStart = week?.startKey ?? "";
  const dayRange = localDayRange(dayKey, timeZone);
  const dayToken = `${dayRange?.from ?? ""}|${dayRange?.to ?? ""}|${reloadKey}`;
  const weekToken = `${weekStart}|${timeZone}|${reloadKey}`;
  const [seenDay, setSeenDay] = useState(dayToken);
  const [seenWeek, setSeenWeek] = useState(weekToken);
  const [dayState, setDayState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [weekState, setWeekState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [heartbeats, setHeartbeats] = useState([]);
  const [weekHeartbeats, setWeekHeartbeats] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [weekTruncated, setWeekTruncated] = useState(false);
  const [error, setError] = useState("");
  const [weekError, setWeekError] = useState("");
  const [connection, setConnection] = useState(null);
  const [connectionError, setConnectionError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState("");

  if (seenDay !== dayToken) {
    setSeenDay(dayToken);
    setDayState(isSupabaseConfigured ? "loading" : "unconfigured");
    setHeartbeats([]);
    setTruncated(false);
    setError("");
  }
  if (seenWeek !== weekToken) {
    setSeenWeek(weekToken);
    setWeekState(isSupabaseConfigured ? "loading" : "unconfigured");
    setWeekHeartbeats([]);
    setWeekTruncated(false);
    setWeekError("");
  }

  const dayFrom = dayRange?.from ?? "";
  const dayTo = dayRange?.to ?? "";

  useEffect(() => {
    if (!isSupabaseConfigured || !dayFrom || !dayTo) return undefined;
    let active = true;
    listLearningObservations({ from: dayFrom, to: dayTo })
      .then((result) => {
        if (!active) return;
        setHeartbeats(heartbeatsFromRows(result.rows));
        setTruncated(result.truncated);
        setDayState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setHeartbeats([]);
        setDayState("error");
        setError(caught?.message || "Could not load learning activity.");
      });
    return () => {
      active = false;
    };
  }, [dayFrom, dayTo, reloadKey]);

  useEffect(() => {
    if (!isSupabaseConfigured || !weekStart) return undefined;
    const days = weekWindow(weekStart)?.days ?? [];
    let active = true;
    Promise.all(
      days.map((day) => {
        const range = localDayRange(day.key, timeZone);
        return range ? listLearningObservations(range) : Promise.resolve({ rows: [], truncated: false });
      })
    )
      .then((results) => {
        if (!active) return;
        setWeekHeartbeats(heartbeatsFromRows(results.flatMap((result) => result.rows)));
        setWeekTruncated(results.some((result) => result.truncated));
        setWeekState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setWeekHeartbeats([]);
        setWeekState("error");
        setWeekError(caught?.message || "Could not load this week's learning activity.");
      });
    return () => {
      active = false;
    };
  }, [weekStart, timeZone, reloadKey]);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    getIntegrationByProvider(LEARNING_PROVIDER)
      .then((row) => {
        if (active) setConnection(row);
      })
      .catch((caught) => {
        if (active) setConnectionError(caught?.message || "Could not load the learning tracker status.");
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  const shownDayState = !isSupabaseConfigured ? "unconfigured" : !dayRange ? "error" : dayState;
  const shownDayError = !dayRange ? "That day could not be read." : error;
  const sessions = useMemo(() => foldHeartbeats(heartbeats), [heartbeats]);
  const dayTotal = coveredSeconds(heartbeats);
  const weekTotal = coveredSeconds(weekHeartbeats);
  const bySite = useMemo(
    () =>
      groupedCoveredSeconds(heartbeats, (beat) => beat.siteLabel || beat.siteHost || "Unknown site").sort(
        (a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)
      ),
    [heartbeats]
  );
  const byCourse = useMemo(
    () =>
      groupedCoveredSeconds(heartbeats, (beat) =>
        beat.courseLabel
          ? `${beat.siteLabel || beat.siteHost} · ${beat.courseLabel}`
          : beat.siteLabel || beat.siteHost || "Unknown site"
      ).sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)),
    [heartbeats]
  );
  const weekDays = useMemo(() => {
    return (week?.days ?? []).map((day) => ({
      ...day,
      seconds: coveredSeconds(
        weekHeartbeats.filter((beat) => localDayKey(beat.occurredAt, timeZone) === day.key)
      ),
    }));
  }, [week, weekHeartbeats, timeZone]);

  const [focusKey, setFocusKey] = useState(null);
  const [focusDay, setFocusDay] = useState(dayKey);
  if (focusDay !== dayKey) {
    setFocusDay(dayKey);
    setFocusKey(null);
  }

  const latest = useMemo(() => {
    const ordered = [...sessions].sort((a, b) => String(b.endedAt ?? "").localeCompare(String(a.endedAt ?? "")));
    return ordered[0] ?? null;
  }, [sessions]);
  const visibleSessions = focusKey
    ? sessions.filter((session) => courseKey(session) === focusKey || siteKey(session) === focusKey)
    : sessions;

  const removeDay = async () => {
    const range = localDayRange(dayKey, timeZone);
    if (!range) return;
    const confirmed = window.confirm(
      `Delete learning activity for ${formatDayHeading(dayKey)}? This removes the heartbeats stored for that day. It does not change coding time or manual sessions.`
    );
    if (!confirmed) return;
    setDeleting(true);
    setActionError("");
    try {
      const result = await deleteLearningObservations(range);
      if (result.deleted === 0) {
        setActionError("Nothing was deleted.");
        return;
      }
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught?.message || "Could not delete learning activity.");
    } finally {
      setDeleting(false);
    }
  };

  const headingDate = formatDayHeading(dayKey);
  const heading = dayKey === today ? "Today" : headingDate.split(",")[0] || headingDate;

  const chooseFocus = (key) => setFocusKey((current) => (current === key ? null : key));

  return (
    <AppShell currentPath="/learning">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-sm text-muted-foreground">{headingDate}</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight">Learning</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Active time on the sites you track. Times follow {timeZone}. This is separate from coding time, manual sessions, and work logs.
            </p>
          </div>
          <section aria-label="Learning totals" className="grid w-full gap-2 sm:w-auto sm:grid-cols-2">
            <Total label={heading} state={shownDayState} error={shownDayError} seconds={dayTotal} empty="No learning activity recorded" />
            <Total label="This week" state={weekState} error={weekError} seconds={weekTotal} empty="No learning activity recorded" />
          </section>
        </header>

        <WeekChart days={weekDays} selectedKey={dayKey} onSelect={setDayKey} recordedWord="learning" />

        <ConnectionNote connection={connection} error={connectionError} configured={isSupabaseConfigured} />

        {truncated || weekTruncated ? (
          <p role="status" className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            Showing the latest 1000 heartbeats in a loaded day. Older heartbeats in that day are not in these totals.
          </p>
        ) : null}

        {shownDayState === "error" ? (
          <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            <p className="font-semibold">Could not load learning activity</p>
            <p className="mt-1">{shownDayError}</p>
          </div>
        ) : null}

        {!isSupabaseConfigured ? (
          <div role="status" className="rounded-xl border border-border bg-card px-3 py-2 text-sm">
            <p className="font-semibold">Not connected</p>
            <p className="mt-1 text-muted-foreground">Configure Supabase to load learning activity.</p>
          </div>
        ) : null}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="grid gap-3">
            {byCourse.length > 0 ? (
              <ShareBars
                title="Courses"
                rows={byCourse}
                selectedKey={focusKey}
                onSelect={chooseFocus}
              />
            ) : shownDayState === "loading" ? null : (
              <p className="rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                Courses show up here after a tracked site records time. The bar is how long you spent, not how much of a course is finished.
              </p>
            )}
            {bySite.length > 0 ? (
              <ShareBars title="Sites" rows={bySite} selectedKey={focusKey} onSelect={chooseFocus} />
            ) : null}
          </div>

          <section aria-label="Learning timeline" className="grid gap-3">
            {latest && shownDayState === "ready" ? (
              <article className="rounded-xl bg-primary px-3 py-3 text-primary-foreground">
                <p className="text-xs font-medium uppercase tracking-wide text-primary-foreground/80">Pick up where you left off</p>
                <h2 className="mt-2 text-base font-semibold">
                  {latest.courseLabel || latest.siteLabel || latest.siteHost || "Learning"}
                </h2>
                <p className="mt-1 text-sm text-primary-foreground/90">
                  {latest.lessons?.[0]?.lessonLabel || latest.lessons?.[0]?.pageTitle || latest.siteLabel || "Session"}
                  {" · "}
                  {durationText(latest.durationSeconds)}
                </p>
                <p className="mt-1 text-xs text-primary-foreground/75">
                  {formatClock(latest.startedAt, timeZone) ?? "No start time"}
                  {latest.endedAt ? ` – ${formatClock(latest.endedAt, timeZone) ?? ""}` : ""}
                </p>
                <button
                  type="button"
                  onClick={() => setFocusKey(focusKey ? null : courseKey(latest) || siteKey(latest))}
                  className="mt-3 inline-flex min-h-9 items-center rounded-lg bg-primary-foreground px-3 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {focusKey ? "Show every course" : "Focus this course"}
                </button>
              </article>
            ) : null}

            <div className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold">Timeline</h2>
                {shownDayState === "ready" && heartbeats.length > 0 ? (
                  <button
                    type="button"
                    onClick={removeDay}
                    disabled={deleting}
                    className="inline-flex min-h-9 items-center rounded-xl border border-border px-2.5 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    {deleting ? "Deleting…" : "Delete this day"}
                  </button>
                ) : null}
              </div>
              {focusKey ? (
                <p className="mt-2 text-xs text-muted-foreground">Showing {focusKey}. Choose it again to see the whole day.</p>
              ) : null}
              {actionError ? (
                <p role="alert" className="mt-2 text-sm text-destructive">{actionError}</p>
              ) : null}
              {shownDayState === "loading" ? (
                <div className="mt-3 space-y-2">
                  <Skeleton className="h-4 w-1/3 mb-1" />
                  <Skeleton className="h-8 w-full mb-2" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : null}
              {shownDayState === "ready" && visibleSessions.length === 0 ? (
                <p className="mt-2 rounded-xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {sessions.length === 0 ? "No learning activity recorded on this day." : "Nothing in this course on this day."}
                </p>
              ) : null}
              {visibleSessions.length > 0 ? (
                <ol className="relative mt-3 space-y-2 border-l border-border pl-4">
                  {visibleSessions.map((session) => {
                    const current = session.id === latest?.id;
                    return (
                      <li key={session.id} className="relative">
                        <span
                          className={`absolute top-4 -left-[22px] h-2.5 w-2.5 rounded-full border-2 bg-background ${current ? "border-primary" : "border-progress"}`}
                          aria-hidden="true"
                        />
                        <article className={`rounded-xl px-3 py-2 ${current ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-sm font-semibold">
                              {session.courseLabel || session.siteLabel || session.siteHost || "Unknown site"}
                            </h3>
                            <p className="shrink-0 text-sm font-medium">
                              {formatClock(session.startedAt, timeZone) ?? "No start time"}
                            </p>
                          </div>
                          <p className={`mt-1 text-xs ${current ? "text-primary-foreground/80" : "text-muted-foreground"}`}>
                            {session.courseLabel ? `${session.siteLabel || session.siteHost} · ` : ""}
                            {durationText(session.durationSeconds)}
                            {session.endedAt ? ` · until ${formatClock(session.endedAt, timeZone) ?? "an unknown time"}` : ""}
                          </p>
                          {session.lessons?.length > 0 ? (
                            <ul className={`mt-2 space-y-1 text-xs ${current ? "text-primary-foreground/85" : "text-muted-foreground"}`}>
                              {session.lessons.slice(0, 8).map((lesson) => (
                                <li key={`${lesson.lessonLabel ?? "none"}-${lesson.pageTitle ?? "none"}`}>
                                  <span className="mb-1 flex items-center justify-between gap-2">
                                    <span className="min-w-0 truncate">{lesson.lessonLabel || lesson.pageTitle || "Page"}</span>
                                    <span className="shrink-0">{durationText(lesson.durationSeconds)}</span>
                                  </span>
                                  <LessonMeter lesson={lesson} sessionSeconds={session.durationSeconds} inverted={current} />
                                </li>
                              ))}
                              {session.lessons.length > 8 ? <li>and {session.lessons.length - 8} more lessons</li> : null}
                            </ul>
                          ) : null}
                        </article>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </div>
          </section>
        </div>

        <TrackedSitesPanel connection={connection} onChanged={() => setReloadKey((value) => value + 1)} />

        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Link to="/settings/integrations" className="inline-flex min-h-9 items-center font-semibold text-primary">
            Tracker setup
          </Link>
          <Link to="/reports" className="inline-flex min-h-9 items-center font-semibold text-primary">
            Reports
          </Link>
        </p>
      </div>
    </AppShell>
  );
}

function Total({ label, state, error, seconds, empty }) {
  let value = "…";
  if (state === "unconfigured") value = "Not connected";
  else if (state === "loading") value = "Loading…";
  else if (state === "error") value = "Could not load";
  else if (seconds == null) value = empty;
  else value = formatDurationFromSeconds(seconds);
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      {state === "error" && error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function courseKey(session) {
  if (session?.courseLabel) return `${session.siteLabel || session.siteHost} · ${session.courseLabel}`;
  return session?.siteLabel || session?.siteHost || "Unknown site";
}

function siteKey(session) {
  return session?.siteLabel || session?.siteHost || "Unknown site";
}

function LessonMeter({ lesson, sessionSeconds, inverted }) {
  const width = lesson.durationSeconds != null && sessionSeconds
    ? Math.max(4, Math.min(100, Math.round((lesson.durationSeconds / sessionSeconds) * 100)))
    : null;
  if (width == null) return null;
  return (
    <span className={`block h-1.5 overflow-hidden rounded-full ${inverted ? "bg-primary-foreground/25" : "bg-background"}`} aria-hidden="true">
      <span
        className={`block h-full rounded-full ${inverted ? "bg-primary-foreground" : "bg-progress"}`}
        style={{ width: `${width}%` }}
      />
    </span>
  );
}

function ConnectionNote({ connection, error, configured }) {
  if (!configured) return null;
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!connection) {
    return (
      <p className="text-sm text-muted-foreground">
        The learning tracker is not connected.{" "}
        <Link to="/settings/integrations" className="font-semibold text-primary">
          Set it up
        </Link>
      </p>
    );
  }
  const synced = connection.last_sync_at ? new Date(connection.last_sync_at).toLocaleString() : null;
  const paused = connection.config?.paused === true;
  return (
    <p className="text-sm text-muted-foreground">
      Tracker status: {connection.status}
      {paused ? ", paused in the browser" : ""}
      {synced ? `. Last sent ${synced}.` : ". No heartbeats have been sent yet."}
    </p>
  );
}
