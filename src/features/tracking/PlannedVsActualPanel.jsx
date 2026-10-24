// Sentral Hub — the "planned vs actual" section of the productivity report.
//
// WHAT THIS SECTION SHOWS: for one date range, the PLAN (each task's estimate)
// next to the RECORDED time (the sessions the tracker stored).
//
// WHY IT READS ITS OWN DATA: the report page is built on the work logs, and a
// work log is a DIFFERENT stream from a session — the same work can be in both.
// Adding the two would count that work twice (docs/DECISIONS.md D-007), so this
// section reads the sessions and the tasks and leaves the logs alone.
//
// WHY THE RULES LIVE ELSEWHERE: the comparison rules are in
// src/features/tracking/plannedVsActual.js, which is pure and is verified by
// scripts/verify-planned-actual.mjs. This file fetches, formats and renders —
// it never decides what a number means.
//
// THE TRUTHFULNESS RULES this view keeps:
//   - A task with NO estimate shows "No estimate" and NO difference. A missing
//     plan is not "on plan" and not "0h".
//   - A session with NO recorded duration is UNRECORDED time: it is counted as
//     such and is never shown as a zero-length session.
//   - Recorded time with no task is reported on its own line and is never
//     spread over the tasks.
//   - Nothing is shown while the data is on its way, after a failed read, or
//     when no database is configured: an unknown total is never "0".

import { useEffect, useMemo, useState } from "react";
import { formatDurationFromSeconds } from "../../dashboard/logUtils";
import { isSupabaseConfigured } from "../../lib/supabase";
import { Skeleton } from "../../components/ui/skeleton";
import { listTaskReferences } from "../../lib/tasks";
import { listRecentCorrections, listSessions } from "../../lib/tracking";
import { ACTIVE_STATUSES, TASK_STATUSES } from "../tasks/taskUtils";
import { summarizePlannedVsActual } from "./plannedVsActual";

const STATUS_LABELS = new Map(
  TASK_STATUSES.map((status) => [status.value, status.label])
);

/**
 * The label of a task status.
 *
 * The status is shown as TEXT (never as a colour alone), and an unknown status
 * is shown as it is stored rather than hidden.
 */
function statusLabel(status) {
  if (!status) return "Unknown status";
  return STATUS_LABELS.get(status) ?? String(status);
}

/**
 * A range bound as an ISO timestamp, or undefined when it cannot be read.
 *
 * WHY undefined and not a guess: a bound the user cannot read is no bound, and a
 * made-up date would silently move the comparison to another range.
 */
function toIsoTimestamp(value) {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * The END of the range, as an EXCLUSIVE bound.
 *
 * WHY it is not the same conversion as the start of the range: the report's
 * range ends at the START of its last day — its own log filter includes that
 * whole day — while `listSessions` treats `to` as an EXCLUSIVE bound. Passing
 * the report's `to` straight through would therefore drop the whole last day of
 * the range without a word. The bound moves to the start of the next LOCAL day,
 * so the panel covers exactly the days the report covers: the report's range is
 * a local-day range, and the tracker files sessions under the local day too.
 */
function toRangeEndIso(value) {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const next = new Date(date.getTime());
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/**
 * A duration in the house format.
 *
 * WHY the seconds formatter: it is lossless. A session of 45 seconds reads
 * "45s" instead of being rounded up to a minute the database never held, and a
 * total of zero seconds reads "0s" instead of claiming "0h" of work.
 */
function formatSeconds(seconds) {
  return formatDurationFromSeconds(seconds);
}

/**
 * The difference between the recorded time and the plan, in plain words.
 *
 * @param {number|null} varianceSeconds positive = over the plan
 * @returns {string|null}
 */
function differenceText(varianceSeconds) {
  if (varianceSeconds === null || varianceSeconds === undefined) return null;
  if (varianceSeconds > 0) return `over by ${formatSeconds(varianceSeconds)}`;
  if (varianceSeconds < 0) return `under by ${formatSeconds(-varianceSeconds)}`;
  return "on plan";
}

/**
 * True when the recorded time of a task is actually known.
 *
 * WHY: a session with no duration is UNRECORDED time, not a zero-length
 * session. A task whose sessions all lack a duration therefore has no actual
 * time to show, and comparing it against the plan would compare an unknown
 * against a plan.
 */
function actualTimeIsKnown(row) {
  return row.sessionCount > 0 && row.sessionsWithoutDuration < row.sessionCount;
}

/**
 * What is known about the sessions behind a task.
 *
 * @returns {string|null} a short note, or null when there is nothing to add
 */
function sessionNote(row) {
  if (row.sessionCount === 0) return "No sessions recorded";
  if (row.sessionsWithoutDuration > 0) {
    if (row.sessionCount === 1) return "1 session has no recorded duration";
    if (row.sessionsWithoutDuration === 1) {
      return `1 of ${row.sessionCount} sessions has no recorded duration`;
    }
    return `${row.sessionsWithoutDuration} of ${row.sessionCount} sessions have no recorded duration`;
  }
  if (row.sessionCount > 1) return `${row.sessionCount} sessions`;
  return null;
}

/**
 * The planned total, or the reason it cannot be shown.
 *
 * WHY "No plan recorded": a plan of zero seconds can mean two different things
 * — there is no open work, or the open work has no estimate at all. Only the
 * second one is missing data, and it must never be rendered as "0s".
 *
 * @param {object} totals
 * @returns {string}
 */
function plannedTotalText(totals) {
  if (totals.tasksInScope === 0) return "No tasks yet";
  if (totals.plannedSeconds === 0 && totals.openTasksWithoutEstimate > 0) {
    return "No plan recorded";
  }
  return formatSeconds(totals.plannedSeconds);
}

/**
 * The recorded total, or the reason it cannot be shown.
 *
 * WHY "No recorded time": a session with no recorded duration is UNRECORDED
 * time. When no session in scope carries a duration, the total is unknown — it
 * must never be rendered as "0s".
 *
 * @param {object} totals
 * @returns {string}
 */
function recordedTotalText(totals) {
  if (totals.sessionsInScope === 0) return "Nothing recorded yet";
  if (totals.actualSeconds === 0 && totals.sessionsWithoutDuration > 0) {
    return "No recorded time";
  }
  return formatSeconds(totals.actualSeconds);
}

/**
 * The unattributed part of the recorded time, or the reason it cannot be shown.
 *
 * @param {object} totals
 * @returns {string}
 */
function unattributedTotalText(totals) {
  if (totals.sessionsInScope === 0) return "Nothing recorded yet";
  if (totals.actualSeconds === 0 && totals.sessionsWithoutDuration > 0) {
    return "No recorded time";
  }
  return formatSeconds(totals.unattributedSeconds);
}

/**
 * The difference between the whole plan and the whole recorded time.
 *
 * WHY the difference is sometimes refused: a difference is only a fact when
 * BOTH sides of it are known. A session with no recorded duration makes the
 * recorded total incomplete, and an open task with no estimate makes the plan
 * incomplete — and an incomplete number must never be compared with a known
 * one, because the difference it produces is not a fact.
 *
 * @param {object} totals
 * @returns {string}
 */
function totalsDifferenceText(totals) {
  // Nothing was recorded, so there is nothing to compare against the plan.
  if (totals.sessionsInScope === 0) return "No recorded time to compare yet";
  // Sessions exist but at least one of them carries no duration: the recorded
  // time is incomplete, not zero, and not a number to compare.
  if (totals.sessionsWithoutDuration > 0) {
    return "Not comparable — the recorded time is incomplete";
  }
  // At least one OPEN task has no estimate: the plan is incomplete too.
  if (totals.openTasksWithoutEstimate > 0) {
    return "Not comparable — the plan is incomplete";
  }
  // No open task has an estimate, so there is no plan to compare against.
  if (totals.plannedSeconds === 0) return "No plan to compare yet";
  const difference = totals.actualSeconds - totals.plannedSeconds;
  if (difference > 0) return `over by ${formatSeconds(difference)}`;
  if (difference < 0) return `under by ${formatSeconds(-difference)}`;
  return "on plan";
}

/**
 * The plain-language notes about what is missing from the data.
 *
 * These notes are part of the section, not an afterthought: they are what keeps
 * a missing number from being read as a zero.
 *
 * @param {object} totals
 * @returns {string[]}
 */
function completenessNotes(totals) {
  const notes = [];

  if (totals.tasksWithoutEstimate > 0) {
    const count = totals.tasksWithoutEstimate;
    // WHY the second sentence: the planned total is the sum of the estimates
    // the tasks HAVE, so when some open task has none, the total covers only
    // part of the plan. Saying so keeps the number from reading as the whole.
    const planPart =
      totals.openTasksWithoutEstimate > 0
        ? " The planned total covers only the open tasks that have an estimate."
        : "";
    notes.push(
      `${count} ${
        count === 1 ? "task has" : "tasks have"
      } no estimate — their plan is unknown, not zero.${planPart}`
    );
  }

  if (totals.sessionsWithoutDuration > 0) {
    const count = totals.sessionsWithoutDuration;
    notes.push(
      `${count} ${
        count === 1 ? "session has" : "sessions have"
      } no recorded duration — that time is unrecorded, not zero. The recorded total covers only the sessions that have a duration.`
    );
  }

  if (totals.unattributedSeconds > 0) {
    notes.push(
      `${formatSeconds(totals.unattributedSeconds)} of recorded time has no task — it is reported on its own and is not spread over the tasks.`
    );
  }

  return notes;
}

function TaskComparisonRow({ row }) {
  const plannedText =
    row.plannedSeconds === null ? "No estimate" : formatSeconds(row.plannedSeconds);

  const known = actualTimeIsKnown(row);
  const actualText = known ? formatSeconds(row.actualSeconds) : "No time recorded";

  // WHY the three "no comparison" texts: a task with no estimate has no plan to
  // compare against; a task with no recorded time has no actual time to
  // compare with; and a task whose sessions are only PARTLY recorded has an
  // incomplete actual time, which must not be compared with the plan. None of
  // them may read as "on plan".
  // WHY the comparison needs a complete actual time: a task whose sessions are
  // only partly recorded has an incomplete actual time, and an incomplete
  // number must not be compared with the plan.
  const comparable =
    row.plannedSeconds !== null &&
    row.sessionCount > 0 &&
    row.sessionsWithoutDuration === 0;

  const difference = (() => {
    if (row.plannedSeconds === null) return "No estimate to compare";
    if (row.sessionCount === 0) return "No recorded time to compare";
    if (!comparable) return "Not comparable — the recorded time is incomplete";
    return differenceText(row.varianceSeconds);
  })();

  // WHY the warning colour follows the difference, not the raw variance: a
  // variance the row does not state is not a difference, and colouring it like
  // an overrun would claim something the data does not support.
  const differenceClass =
    comparable && row.varianceSeconds !== null && row.varianceSeconds > 0
      ? "text-destructive"
      : "text-foreground";

  const note = sessionNote(row);

  return (
    <li className="rounded-xl border border-border bg-background p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold text-foreground">
          {row.title || "Untitled task"}
        </p>
        <span className="rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground">
          {statusLabel(row.status)}
        </span>
      </div>

      <dl className="mt-2 grid gap-2 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Planned</dt>
          <dd className="text-sm font-medium text-foreground">{plannedText}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Recorded</dt>
          <dd className="text-sm font-medium text-foreground">{actualText}</dd>
          {note ? (
            <p className="text-xs text-muted-foreground">{note}</p>
          ) : null}
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Difference</dt>
          <dd className={`text-sm font-medium ${differenceClass}`}>{difference}</dd>
        </div>
      </dl>
    </li>
  );
}

export default function PlannedVsActualPanel({ from, to }) {
  const fromIso = useMemo(() => toIsoTimestamp(from), [from]);
  // WHY the end is converted differently: `listSessions` treats `to` as an
  // EXCLUSIVE bound, while the report's range ends at the START of its last
  // day. `toRangeEndIso` moves the bound to the end of that day so the last
  // day is covered instead of dropped.
  const toIso = useMemo(() => toRangeEndIso(to), [to]);
  const requestKey = `${fromIso ?? ""}|${toIso ?? ""}`;

  // WHY the result carries the key of the request it belongs to: the state is
  // written only when a read finishes, and the key says WHICH read produced
  // it. A new range therefore shows the loading state again without writing
  // any state from inside the effect.
  const [result, setResult] = useState(null);

  // WHY the panel fetches for itself: the report page is built on the work
  // logs, and the logs are a different stream from the recorded sessions. The
  // comparison needs the sessions and the tasks — and only those.
  useEffect(() => {
    let cancelled = false;

    if (!isSupabaseConfigured) {
      return () => {
        cancelled = true;
      };
    }

    Promise.all([
      listSessions({ from: fromIso, to: toIso }),
      listRecentCorrections(),
      listTaskReferences(),
    ]).then(
      ([sessions, corrections, tasks]) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          status: "ready",
          summary: summarizePlannedVsActual({
            sessions: sessions.rows,
            tasks: tasks.rows,
            corrections: corrections.rows,
            openStatuses: ACTIVE_STATUSES,
          }),
          truncation: {
            sessions: { loaded: sessions.rows.length, total: sessions.total },
            corrections: {
              loaded: corrections.rows.length,
              total: corrections.total,
            },
            tasks: { loaded: tasks.rows.length, total: tasks.total },
          },
        });
      },
      (err) => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          status: "error",
          error: err?.message || "Could not load the comparison.",
        });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [fromIso, toIso, requestKey]);

  const notConfigured = !isSupabaseConfigured;
  const current = result?.key === requestKey ? result : null;
  const status = notConfigured
    ? "not-connected"
    : current === null
      ? "loading"
      : current.status;
  const error = current?.status === "error" ? current.error : null;
  const summary = current?.summary ?? null;
  const truncation = current?.truncation ?? null;
  const totals = summary?.totals ?? null;
  const rows = summary?.rows ?? [];

  const plannedText = totals ? plannedTotalText(totals) : null;
  const recordedText = totals ? recordedTotalText(totals) : null;
  const unattributedText = totals ? unattributedTotalText(totals) : null;

  // WHY this state has a message of its own: with no tasks and no sessions
  // there is nothing to compare, and the summary cards would say the same
  // thing three times ("No tasks yet", "Nothing recorded yet", "No recorded
  // time to compare yet") before a fourth sentence said it again. One message
  // says it once — and two sentences glued together ("…yetNo tasks…") read as
  // one broken sentence.
  const nothingAtAll =
    totals !== null && totals.tasksInScope === 0 && totals.sessionsInScope === 0;

  const notes = totals ? completenessNotes(totals) : [];

  const truncationText = (() => {
    if (!truncation) return null;
    const parts = [];
    if (
      truncation.sessions.total !== null &&
      truncation.sessions.total > truncation.sessions.loaded
    ) {
      parts.push(
        `${truncation.sessions.loaded} of ${truncation.sessions.total} sessions`
      );
    }
    if (
      truncation.corrections.total !== null &&
      truncation.corrections.total > truncation.corrections.loaded
    ) {
      parts.push(
        `${truncation.corrections.loaded} of ${truncation.corrections.total} corrections`
      );
    }
    if (
      truncation.tasks.total !== null &&
      truncation.tasks.total > truncation.tasks.loaded
    ) {
      parts.push(
        `${truncation.tasks.loaded} of ${truncation.tasks.total} tasks`
      );
    }
    if (parts.length === 0) return null;
    return `Only part of the data is loaded (${parts.join(", ")}), so every number here covers the loaded subset only.`;
  })();

  return (
    <section
      aria-labelledby="planned-vs-actual-heading"
      className="rounded-[1.75rem] border border-border bg-card-cream p-4 shadow-lift sm:p-5"
    >
      <h2
        id="planned-vs-actual-heading"
        className="text-lg font-semibold text-foreground"
      >
        Planned vs actual
      </h2>
      {/* WHY the separators: the heading, the introduction and the state below
          are separate BLOCK elements, so the text of the section would run its
          sentences together when it is read as plain text ("…actualTime
          recorded…", "…twice.Planned…"). The separators keep the sentences
          apart. They change nothing visually. */}
      {" "}
      <p className="mt-1 text-sm text-muted-foreground">
        Time recorded against each task&apos;s estimate. Totals come from recorded
        sessions only — manual work logs are not included, so nothing is counted
        twice.
      </p>
      {" "}

      {status === "not-connected" ? (
        <p
          role="status"
          className="mt-4 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground"
        >
          Not connected. Configure Supabase to load the comparison.
        </p>
      ) : status === "loading" ? (
        <div className="mt-4 rounded-xl border border-border bg-background px-4 py-3">
          <Skeleton className="h-4 w-1/3 mb-1" />
          <Skeleton className="h-6 w-full mb-1" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : status === "error" ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground"
        >
          <p className="font-semibold text-foreground">
            Could not load the comparison.
          </p>
          <p className="mt-1">{error}</p>
        </div>
      ) : nothingAtAll ? (
        <>
          {truncationText ? (
            <p
              role="status"
              className="mt-4 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground"
            >
              {truncationText}
            </p>
          ) : null}

          <p className="mt-4 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Nothing recorded yet. There are no tasks to compare yet.
          </p>
        </>
      ) : (
        <>
          {truncationText ? (
            <p
              role="status"
              className="mt-4 rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground"
            >
              {truncationText}
            </p>
          ) : null}

          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card-gold p-3 shadow-lift">
              <dt className="text-xs font-semibold tracking-wide text-foreground/70 uppercase">
                Planned (open tasks)
              </dt>
              <dd className="mt-1 text-xl font-semibold text-foreground">
                {plannedText}
              </dd>
            </div>
            <div className="rounded-xl border border-border bg-card-sky p-3 shadow-lift">
              <dt className="text-xs font-semibold tracking-wide text-foreground/70 uppercase">
                Recorded
              </dt>
              <dd className="mt-1 text-xl font-semibold text-foreground">
                {recordedText}
              </dd>
            </div>
            <div className="rounded-xl border border-border bg-card-coral p-3 shadow-lift">
              <dt className="text-xs font-semibold tracking-wide text-foreground/70 uppercase">
                Difference
              </dt>
              <dd className="mt-1 text-xl font-semibold text-foreground">
                {totalsDifferenceText(totals)}
              </dd>
            </div>
          </dl>

          <p className="mt-2 text-sm text-muted-foreground">
            Unattributed time (recorded time with no task):{" "}
            <span className="font-medium text-foreground">{unattributedText}</span>
          </p>

          <p className="mt-1 text-sm text-muted-foreground">
            The plan counts the estimates of open tasks only.
            {totals && totals.completedPlanSeconds > 0
              ? ` A further ${formatSeconds(totals.completedPlanSeconds)} of estimates belongs to finished tasks and is not part of the remaining plan.`
              : ""}
          </p>

          {notes.length > 0 ? (
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}

          {rows.length > 0 ? (
            <ul className="mt-4 space-y-2">
              {rows.map((row) => (
                <TaskComparisonRow key={row.taskId ?? row.title} row={row} />
              ))}
            </ul>
          ) : (
            <>
              {" "}
              <p className="mt-4 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                There are no tasks to compare yet.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
