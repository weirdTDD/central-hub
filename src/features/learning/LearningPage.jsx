// One day's learning time, grouped into sessions by site and course.
//
// The numbers come from learning heartbeats (observations with activity_kind
// learning). They are not added to work logs, manual sessions, or coding time.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import AppShell from "../../components/AppShell";
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

  const recordedDays = useMemo(() => {
    const days = new Set();
    for (const beat of weekHeartbeats) {
      const key = localDayKey(beat.occurredAt, timeZone);
      if (key) days.add(key);
    }
    return days;
  }, [weekHeartbeats, timeZone]);

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

  return (
    <AppShell currentPath="/learning">
      <div className="mx-auto flex max-w-lg flex-col gap-6">
        <header>
          <p className="text-sm text-muted-foreground">{headingDate}</p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight">Learning</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Active time on the sites you track. Times follow {timeZone}. This is separate from coding time, manual sessions, and work logs.
          </p>
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
                  aria-label={`${day.weekday} ${day.dayNumber}${recorded ? ", learning recorded" : ""}`}
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
                    className={`mt-0.5 h-1.5 w-1.5 rounded-full ${recorded ? "bg-progress" : "bg-transparent"}`}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </nav>

        <section aria-label="Learning totals" className="grid gap-3 sm:grid-cols-2">
          <Total label={heading} state={shownDayState} error={shownDayError} seconds={dayTotal} empty="No learning activity recorded" />
          <Total label="This week" state={weekState} error={weekError} seconds={weekTotal} empty="No learning activity recorded" />
        </section>

        {weekState === "ready" ? (
          <section aria-label="This week by day" className="rounded-2xl border border-border bg-card px-4 py-3">
            <h2 className="text-sm font-semibold">This week</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {weekDays.map((day) => (
                <li key={day.key} className="flex items-center justify-between gap-3">
                  <span>{day.weekday}</span>
                  <span className="text-muted-foreground">
                    {day.seconds == null ? "Nothing recorded" : durationText(day.seconds)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <ConnectionNote connection={connection} error={connectionError} configured={isSupabaseConfigured} />

        {truncated || weekTruncated ? (
          <p role="status" className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            Showing the latest 1000 heartbeats in a loaded day. Older heartbeats in that day are not in these totals.
          </p>
        ) : null}

        {shownDayState === "error" ? (
          <div role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <p className="font-semibold">Could not load learning activity</p>
            <p className="mt-1">{shownDayError}</p>
          </div>
        ) : null}

        {!isSupabaseConfigured ? (
          <div role="status" className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
            <p className="font-semibold">Not connected</p>
            <p className="mt-1 text-muted-foreground">Configure Supabase to load learning activity.</p>
          </div>
        ) : null}

        {bySite.length > 0 || byCourse.length > 0 ? (
          <section aria-label="By site and course" className="grid gap-3">
            <Breakdown title="Sites" rows={bySite} />
            <Breakdown title="Courses" rows={byCourse} />
          </section>
        ) : null}

        <section aria-label="Learning timeline">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Timeline</h2>
            {shownDayState === "ready" && heartbeats.length > 0 ? (
              <button
                type="button"
                onClick={removeDay}
                disabled={deleting}
                className="inline-flex min-h-11 items-center rounded-xl border border-border px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {deleting ? "Deleting…" : "Delete this day"}
              </button>
            ) : null}
          </div>
          {actionError ? (
            <p role="alert" className="mt-2 text-sm text-destructive">{actionError}</p>
          ) : null}
          {shownDayState === "loading" ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : null}
          {shownDayState === "ready" && sessions.length === 0 ? (
            <p className="mt-3 rounded-2xl bg-muted px-4 py-6 text-sm text-muted-foreground">
              No learning activity recorded on this day.
            </p>
          ) : null}
          {sessions.length > 0 ? (
            <ol className="relative mt-4 space-y-3 border-l border-border pl-5">
              {sessions.map((session) => (
                <li key={session.id} className="relative">
                  <span
                    className="absolute top-5 -left-[26px] h-3 w-3 rounded-full border-2 border-progress bg-background"
                    aria-hidden="true"
                  />
                  <article className="rounded-2xl bg-muted px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold">
                        {session.courseLabel || session.siteLabel || session.siteHost || "Unknown site"}
                      </h3>
                      <p className="shrink-0 text-sm font-medium">
                        {formatClock(session.startedAt, timeZone) ?? "No start time"}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {session.courseLabel ? `${session.siteLabel || session.siteHost} · ` : ""}
                      {durationText(session.durationSeconds)}
                      {session.endedAt ? ` · until ${formatClock(session.endedAt, timeZone) ?? "an unknown time"}` : ""}
                    </p>
                    {session.lessons?.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {session.lessons.slice(0, 8).map((lesson) => (
                          <li key={`${lesson.lessonLabel ?? "none"}-${lesson.pageTitle ?? "none"}`}>
                            {lesson.lessonLabel || lesson.pageTitle || "Page"}
                            {" · "}
                            {durationText(lesson.durationSeconds)}
                          </li>
                        ))}
                        {session.lessons.length > 8 ? <li>and {session.lessons.length - 8} more lessons</li> : null}
                      </ul>
                    ) : null}
                  </article>
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        <TrackedSitesPanel connection={connection} onChanged={() => setReloadKey((value) => value + 1)} />

        <p className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
          <Link to="/settings/integrations" className="inline-flex min-h-11 items-center font-semibold text-primary">
            Tracker setup
          </Link>
          <Link to="/reports" className="inline-flex min-h-11 items-center font-semibold text-primary">
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
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      {state === "error" && error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function Breakdown({ title, rows }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3">
            <span>{row.key}</span>
            <span className="text-muted-foreground">{durationText(row.activeSeconds)}</span>
          </li>
        ))}
      </ul>
    </section>
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
