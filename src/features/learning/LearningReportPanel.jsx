// Learning time for the report's date range.
//
// Shown beside coding time, and not added to it or to planned-versus-actual.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "../../components/ui/skeleton";
import { durationText } from "../../dashboard/todayView";
import {
  coveredSeconds,
  groupedCoveredSeconds,
  heartbeatsFromRows,
} from "../../../extensions/learning-tracker/lib/learningTime.js";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listLearningObservations } from "../../lib/tracking";
import { ShareBars } from "../progress/Bars.jsx";
import { reportRangeBounds } from "../coding/range.js";

export default function LearningReportPanel({ from, to }) {
  const bounds = useMemo(() => reportRangeBounds(from, to), [from, to]);
  const requestKey = `${bounds.from ?? ""}|${bounds.to ?? ""}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  const [state, setState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [heartbeats, setHeartbeats] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");

  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setState(isSupabaseConfigured ? "loading" : "unconfigured");
    setHeartbeats([]);
    setTruncated(false);
    setError("");
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    listLearningObservations({ from: bounds.from, to: bounds.to, limit: 1000 })
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
  }, [bounds.from, bounds.to, requestKey]);

  const total = coveredSeconds(heartbeats);
  const sites = groupedCoveredSeconds(heartbeats, (beat) => beat.siteLabel || beat.siteHost || "Unknown site").sort(
    (a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)
  );
  const courses = groupedCoveredSeconds(heartbeats, (beat) =>
    beat.courseLabel ? `${beat.siteLabel || beat.siteHost} · ${beat.courseLabel}` : beat.siteLabel || beat.siteHost || "Unknown site"
  ).sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1));

  return (
    <section aria-labelledby="learning-report-heading" className="rounded-xl border border-border bg-card-rose p-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="learning-report-heading" className="text-base font-semibold">Learning time</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Active time on tracked learning sites in this range. It is not added to coding time, work logs, or planned versus actual.
          </p>
        </div>
        <Link
          to="/learning"
          className="inline-flex min-h-9 items-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open timeline
        </Link>
      </div>

      {state === "unconfigured" ? (
        <p className="mt-2 text-sm text-muted-foreground">Not connected. Configure Supabase to load learning activity.</p>
      ) : null}
      {state === "loading" ? (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-4 w-1/3 mb-1" />
          <Skeleton className="h-8 w-full mb-2" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : null}
      {state === "error" ? (
        <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>
      ) : null}
      {state === "ready" && total == null ? (
        <p className="mt-2 text-sm text-muted-foreground">No learning activity recorded in this range.</p>
      ) : null}
      {state === "ready" && total != null ? (
        <>
          <p className="mt-2 text-2xl font-semibold">{durationText(total)}</p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <ShareBars title="Sites" rows={sites} />
            <ShareBars title="Courses" rows={courses} />
          </div>
        </>
      ) : null}
      {truncated ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          This range has more heartbeats than were loaded, so the total covers the loaded ones only.
        </p>
      ) : null}
    </section>
  );
}
