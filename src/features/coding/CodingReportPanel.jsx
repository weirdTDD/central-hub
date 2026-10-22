// Coding time for the report's date range.
//
// Shown beside planned-versus-actual, and not added to it. Coding heartbeats
// are editor activity; planned-versus-actual reads sessions and task estimates.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { durationText } from "../../dashboard/todayView";
import {
  coveredSeconds,
  editorLabel,
  groupedCoveredSeconds,
  heartbeatsFromRows,
} from "../../../extensions/coding-tracker/lib/codingTime.js";
import { isSupabaseConfigured } from "../../lib/supabase";
import { listCodingObservations } from "../../lib/tracking";
import { reportRangeBounds } from "./range.js";

export default function CodingReportPanel({ from, to }) {
  const bounds = useMemo(() => reportRangeBounds(from, to), [from, to]);
  const requestKey = `${bounds.from ?? ""}|${bounds.to ?? ""}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  const [state, setState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [heartbeats, setHeartbeats] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [totalCount, setTotalCount] = useState(null);
  const [error, setError] = useState("");

  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setState(isSupabaseConfigured ? "loading" : "unconfigured");
    setHeartbeats([]);
    setTruncated(false);
    setTotalCount(null);
    setError("");
  }

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    listCodingObservations({ from: bounds.from, to: bounds.to, limit: 1000 })
      .then((result) => {
        if (!active) return;
        setHeartbeats(heartbeatsFromRows(result.rows));
        setTruncated(result.truncated);
        setTotalCount(result.total);
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
  }, [bounds.from, bounds.to, requestKey]);

  const total = coveredSeconds(heartbeats);
  const projects = groupedCoveredSeconds(heartbeats, (beat) => beat.projectName || "No project").sort(
    (a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)
  );
  const editors = groupedCoveredSeconds(heartbeats, (beat) => editorLabel(beat.editor || "unknown"));
  const projectsMeasured = projects.every((row) => row.activeSeconds != null);
  const projectSum = projectsMeasured
    ? projects.reduce((sum, row) => sum + row.activeSeconds, 0)
    : null;
  const overlaps = total != null && projectSum != null && projectSum > total;

  return (
    <section aria-labelledby="coding-report-heading" className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="coding-report-heading" className="text-lg font-semibold">Coding time</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Active time recorded by the Cursor and VS Code extension in this range. It is not added to work logs or to planned versus actual.
          </p>
        </div>
        <Link
          to="/coding"
          className="inline-flex min-h-11 items-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open timeline
        </Link>
      </div>

      {state === "unconfigured" ? (
        <p className="mt-4 text-sm text-muted-foreground">Not connected. Configure Supabase to load coding activity.</p>
      ) : null}
      {state === "loading" ? <p className="mt-4 text-sm text-muted-foreground">Loading coding activity…</p> : null}
      {state === "error" ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>
      ) : null}
      {state === "ready" && total == null ? (
        <p className="mt-4 text-sm text-muted-foreground">No coding activity recorded in this range.</p>
      ) : null}
      {state === "ready" && total != null ? (
        <>
          <p className="mt-4 text-2xl font-semibold">{durationText(total)}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {editors.map((row) => `${row.key} ${durationText(row.activeSeconds)}`).join(" · ")}
          </p>
          {overlaps ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Projects overlap in time. The total counts each minute once, so it is smaller than the sum of the projects.
            </p>
          ) : null}
          <ul className="mt-4 space-y-2 text-sm">
            {projects.map((project) => (
              <li key={project.key} className="flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-2">
                <span className="font-medium">{project.key}</span>
                <span className="text-muted-foreground">{durationText(project.activeSeconds)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {truncated ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {totalCount != null
            ? `${heartbeats.length} of ${totalCount} heartbeats are loaded. The total covers the loaded ones only.`
            : "The loaded heartbeats are incomplete, so the total covers them only."}
        </p>
      ) : null}
    </section>
  );
}
