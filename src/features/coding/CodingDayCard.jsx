// The selected day's coding time on the dashboard.
//
// Kept separate from the journal: the journal is manual and recorded sessions,
// and coding heartbeats are editor activity. The two are not added together.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "../../components/ui/skeleton";
import { durationText, formatDayHeading } from "../../dashboard/todayView";
import {
  coveredSeconds,
  editorLabel,
  groupedCoveredSeconds,
  heartbeatsFromRows,
} from "../../../extensions/coding-tracker/lib/codingTime.js";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listCodingObservations } from "../../lib/tracking";
import { MeterRows } from "../progress/Bars.jsx";
import { localDayRange } from "./range.js";

export default function CodingDayCard({ dayKey, timeZone }) {
  const requestKey = `${dayKey}|${timeZone}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  const [state, setState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [heartbeats, setHeartbeats] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const range = localDayRange(dayKey, timeZone);
  const from = range?.from;
  const to = range?.to;

  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setState(isSupabaseConfigured ? "loading" : "unconfigured");
    setHeartbeats([]);
    setTruncated(false);
    setError("");
  }

  useEffect(() => {
    if (!isSupabaseConfigured || !from || !to) return undefined;
    let active = true;
    listCodingObservations({ from, to })
      .then((result) => {
        if (!active) return;
        setHeartbeats(heartbeatsFromRows(result.rows));
        setTruncated(result.truncated);
        setState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setHeartbeats([]);
        setState("error");
        setError(caught?.message || "Could not load coding activity.");
      });
    return () => {
      active = false;
    };
  }, [from, to]);

  const viewState = !isSupabaseConfigured ? "unconfigured" : !range ? "error" : state;
  const viewError = !range ? "That day could not be read." : error;
  const total = coveredSeconds(heartbeats);
  const projects = groupedCoveredSeconds(heartbeats, (beat) => beat.projectName || "No project")
    .sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1))
    .slice(0, 3);
  const editors = groupedCoveredSeconds(heartbeats, (beat) => editorLabel(beat.editor || "unknown"));

  return (
    <section aria-labelledby="coding-heading" className="rounded-3xl border border-border bg-card-sky p-4 shadow-lift sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="coding-heading" className="text-lg font-semibold">Coding</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Active editor time on {formatDayHeading(dayKey)}. Not included in the recorded-session total above.
          </p>
        </div>
        <Link
          to="/coding"
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Timeline
        </Link>
      </div>
      <div className="mt-4">
        {viewState === "unconfigured" ? (
          <p className="text-sm text-muted-foreground">Not connected. Configure Supabase to load coding activity.</p>
        ) : null}
        {viewState === "loading" ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-4 w-1/3 mb-1" />
            <Skeleton className="h-8 w-full mb-2" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}
        {viewState === "error" ? (
          <p role="alert" className="text-sm text-destructive">{viewError}</p>
        ) : null}
        {viewState === "ready" && total == null ? (
          <p className="text-sm text-muted-foreground">No coding activity recorded on this day.</p>
        ) : null}
        {viewState === "ready" && total != null ? (
          <>
            <p className="text-lg font-semibold">{durationText(total)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {editors.map((row) => `${row.key} ${durationText(row.activeSeconds)}`).join(" · ")}
            </p>
            {projects.length > 0 ? <MeterRows rows={projects} /> : null}
          </>
        ) : null}
        {truncated ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This day has more heartbeats than were loaded, so the total covers the loaded ones only.
          </p>
        ) : null}
      </div>
    </section>
  );
}
