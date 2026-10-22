// One day's coding time, grouped into sessions by project and editor.
//
// The numbers come from coding heartbeats (observations with activity_kind
// coding). They are not added to work logs or to manual sessions.

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
  editorLabel,
  foldHeartbeats,
  groupedCoveredSeconds,
  heartbeatsFromRows,
} from "../../../extensions/coding-tracker/lib/codingTime.js";
import { localDayKey, systemTimeZone } from "../../lib/dates";
import { getIntegrationByProvider } from "../../lib/integrations";
import { isSupabaseConfigured } from "../../lib/supabase";
import { deleteCodingObservations, listCodingObservations } from "../../lib/tracking";
import { localDayRange } from "./range.js";

const CODING_PROVIDER = "coding_tracker";

export default function CodingPage() {
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
    listCodingObservations({ from: dayFrom, to: dayTo })
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
        setError(caught?.message || "Could not load coding activity.");
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
        return range ? listCodingObservations(range) : Promise.resolve({ rows: [], truncated: false });
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
        setWeekError(caught?.message || "Could not load this week's coding activity.");
      });
    return () => {
      active = false;
    };
  }, [weekStart, timeZone, reloadKey]);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    getIntegrationByProvider(CODING_PROVIDER)
      .then((row) => {
        if (active) setConnection(row);
      })
      .catch((caught) => {
        if (active) setConnectionError(caught?.message || "Could not load the coding tracker status.");
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
  const byProject = useMemo(
    () =>
      groupedCoveredSeconds(
        heartbeats,
        (beat) => beat.projectName || "No project"
      ).sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)),
    [heartbeats]
  );
  const byEditor = useMemo(
    () =>
      groupedCoveredSeconds(heartbeats, (beat) => beat.editor || "unknown").sort(
        (a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)
      ),
    [heartbeats]
  );

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
      `Delete coding activity for ${formatDayHeading(dayKey)}? This removes the heartbeats stored for that day. It does not change manual sessions.`
    );
    if (!confirmed) return;
    setDeleting(true);
    setActionError("");
    try {
      const result = await deleteCodingObservations(range);
      if (result.deleted === 0) {
        setActionError("Nothing was deleted.");
        return;
      }
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught?.message || "Could not delete coding activity.");
    } finally {
      setDeleting(false);
    }
  };

  const headingDate = formatDayHeading(dayKey);
  const heading = dayKey === today ? "Today" : headingDate.split(",")[0] || headingDate;

  return (
    <AppShell currentPath="/coding">
      <div className="mx-auto flex max-w-lg flex-col gap-6">
        <header>
          <p className="text-sm text-muted-foreground">{headingDate}</p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight">Coding</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Active time in Cursor and VS Code. Times follow {timeZone}. This is separate from manual sessions and work logs.
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
                  aria-label={`${day.weekday} ${day.dayNumber}${recorded ? ", coding recorded" : ""}`}
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

        <section aria-label="Coding totals" className="grid gap-3 sm:grid-cols-2">
          <Total
            label={heading}
            state={shownDayState}
            error={shownDayError}
            seconds={dayTotal}
            empty="No coding activity recorded"
          />
          <Total
            label="This week"
            state={weekState}
            error={weekError}
            seconds={weekTotal}
            empty="No coding activity recorded"
          />
        </section>

        <ConnectionNote connection={connection} error={connectionError} configured={isSupabaseConfigured} />

        {truncated || weekTruncated ? (
          <p role="status" className="rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            Showing the latest 1000 heartbeats in a loaded day. Older heartbeats in that day are not in these totals.
          </p>
        ) : null}

        {shownDayState === "error" ? (
          <div role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <p className="font-semibold">Could not load coding activity</p>
            <p className="mt-1">{shownDayError}</p>
          </div>
        ) : null}

        {!isSupabaseConfigured ? (
          <div role="status" className="rounded-2xl border border-border bg-card px-4 py-3 text-sm">
            <p className="font-semibold">Not connected</p>
            <p className="mt-1 text-muted-foreground">Configure Supabase to load coding activity.</p>
          </div>
        ) : null}

        {byEditor.length > 0 || byProject.length > 0 ? (
          <section aria-label="By editor and project" className="grid gap-3">
            <Breakdown title="Editors" rows={byEditor} labelOf={(row) => editorLabel(row.key)} />
            <Breakdown title="Projects" rows={byProject} labelOf={(row) => row.key} />
          </section>
        ) : null}

        <section aria-label="Coding timeline">
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
              No coding activity recorded on this day.
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
                      <h3 className="text-sm font-semibold">{session.projectName || "No project"}</h3>
                      <p className="shrink-0 text-sm font-medium">
                        {formatClock(session.startedAt, timeZone) ?? "No start time"}
                      </p>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {editorLabel(session.editor)} · {durationText(session.durationSeconds)}
                      {session.endedAt ? ` · until ${formatClock(session.endedAt, timeZone) ?? "an unknown time"}` : ""}
                    </p>
                    {session.files?.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                        {session.files.slice(0, 8).map((file) => (
                          <li key={`${file.fileName ?? "none"}-${file.language ?? "none"}`}>
                            {file.fileName || "No file"}
                            {file.language ? ` · ${file.language}` : ""}
                            {" · "}
                            {durationText(file.durationSeconds)}
                          </li>
                        ))}
                        {session.files.length > 8 ? (
                          <li>and {session.files.length - 8} more files</li>
                        ) : null}
                      </ul>
                    ) : null}
                  </article>
                </li>
              ))}
            </ol>
          ) : null}
        </section>

        <p className="text-sm text-muted-foreground">
          <Link to="/settings/integrations" className="font-semibold text-primary">
            Tracker setup
          </Link>
          {" · "}
          <Link to="/reports" className="font-semibold text-primary">
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

function Breakdown({ title, rows, labelOf }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-2xl border border-border bg-card px-4 py-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="mt-2 space-y-1 text-sm">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3">
            <span>{labelOf(row)}</span>
            <span className="text-muted-foreground">{durationText(row.activeSeconds)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConnectionNote({ connection, error, configured }) {
  if (!configured) return null;
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!connection) {
    return (
      <p className="text-sm text-muted-foreground">
        The coding tracker is not connected.{" "}
        <Link to="/settings/integrations" className="font-semibold text-primary">
          Set it up
        </Link>
      </p>
    );
  }
  const synced = connection.last_sync_at
    ? new Date(connection.last_sync_at).toLocaleString()
    : null;
  const paused = connection.config?.paused === true;
  return (
    <p className="text-sm text-muted-foreground">
      Tracker status: {connection.status}
      {paused ? ", paused in the editor" : ""}
      {synced ? `. Last sent ${synced}.` : ". No heartbeats have been sent yet."}
    </p>
  );
}
