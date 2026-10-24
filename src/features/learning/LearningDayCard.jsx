// The selected day's learning time on the dashboard.
//
// Kept separate from the journal and from coding: learning heartbeats are
// browser time on allowlisted sites. The streams are not added together.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "../../components/ui/skeleton";
import { durationText, formatDayHeading } from "../../dashboard/todayView";
import {
  coveredSeconds,
  groupedCoveredSeconds,
  heartbeatsFromRows,
} from "../../../extensions/learning-tracker/lib/learningTime.js";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listLearningObservations } from "../../lib/tracking";
import { MeterRows } from "../progress/Bars.jsx";
import { localDayRange } from "../coding/range.js";

export default function LearningDayCard({ dayKey, timeZone }) {
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
    listLearningObservations({ from, to })
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
        setError(caught?.message || "Could not load learning activity.");
      });
    return () => {
      active = false;
    };
  }, [from, to]);

  const viewState = !isSupabaseConfigured ? "unconfigured" : !range ? "error" : state;
  const viewError = !range ? "That day could not be read." : error;
  const total = coveredSeconds(heartbeats);
  const sites = groupedCoveredSeconds(heartbeats, (beat) => beat.siteLabel || beat.siteHost || "Unknown site")
    .sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1))
    .slice(0, 3);

  return (
    <section aria-labelledby="learning-heading" className="rounded-xl border border-border bg-card-rose p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="learning-heading" className="text-base font-semibold">Learning</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Active time on tracked learning sites on {formatDayHeading(dayKey)}. Not included in recorded sessions or coding time.
          </p>
        </div>
        <Link
          to="/learning"
          className="inline-flex min-h-9 items-center justify-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Timeline
        </Link>
      </div>
      <div className="mt-3">
        {viewState === "unconfigured" ? (
          <p className="text-sm text-muted-foreground">Not connected. Configure Supabase to load learning activity.</p>
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
          <p className="text-sm text-muted-foreground">No learning activity recorded on this day.</p>
        ) : null}
        {viewState === "ready" && total != null ? (
          <>
            <p className="text-lg font-semibold">{durationText(total)}</p>
            {sites.length > 0 ? <MeterRows rows={sites} /> : null}
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
