// Central Hub — time-tracking domain logic: sessionization, duration math, attribution.
//
// Serves MASTER_SPEC Section 7C:
//   - Observation -> Session -> Attribution -> Outcome.
//   - Durations use ONE unit: integer seconds.
//   - Overlapping sessions/events MUST NOT be double-counted: the rule is defined here,
//     once, and applied everywhere.
//   - Late and out-of-order events MUST be accepted and correctly recompute affected
//     sessions.
//   - Missing data is represented as missing, never as zero.
//
// This module is deliberately PURE (no React, no network, no browser APIs) so the rules
// can be verified with plain Node assertions — see scripts/verify-tracking.mjs.

import { localDayKey as dayKey } from "../../lib/dates.js";

/** Default maximum gap between two observations that still belong to one session. */
export const DEFAULT_GAP_THRESHOLD_SECONDS = 300;

/** Sources that may be recorded as the origin of an attribution. */
export const ATTRIBUTION_SOURCES = ["manual", "rule", "inferred"];

/** Confidence at or above which a rule/inferred attribution is worth surfacing. */
export const ATTRIBUTION_SUGGESTION_THRESHOLD = 0.5;

/**
 * Converts an ISO timestamp to epoch seconds.
 *
 * @param {string|number|Date} value
 * @returns {number|null} epoch seconds, or null when the value is not a valid date
 */
export function toEpochSeconds(value) {
  if (value == null) return null;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value * 1000
        : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms / 1000;
}

/**
 * Normalises an observation into a half-open interval [start, end).
 *
 * An observation with a positive duration covers that span. An observation WITHOUT a
 * duration is a POINT event: it anchors a session (it happened) but contributes no
 * measured time. That distinction is what keeps "not recorded" separate from zero.
 *
 * @param {object} observation
 * @returns {{start:number, end:number, idle:boolean, observation:object}|null}
 */
function toInterval(observation) {
  const start = toEpochSeconds(observation?.occurred_at ?? observation?.occurredAt);
  if (start === null) return null;

  const rawDuration = observation?.duration_seconds ?? observation?.durationSeconds;
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;

  return {
    start,
    end: start + duration,
    idle: observation?.is_idle === true || observation?.isIdle === true,
    observation,
  };
}

/**
 * Merges overlapping or touching intervals into a minimal set of disjoint intervals.
 *
 * @param {Array<{start:number, end:number}>} intervals
 * @returns {Array<{start:number, end:number}>} sorted, disjoint intervals
 */
export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((i) => Number.isFinite(i?.start) && Number.isFinite(i?.end) && i.end >= i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      if (current.end > last.end) last.end = current.end;
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }
  return merged;
}

/**
 * Total length covered by a set of intervals — the OVERLAP RULE.
 *
 * Overlapping intervals are counted ONCE. This is the single definition used for both
 * session durations and reporting totals, so the same observed minute can never be
 * counted twice.
 *
 * @param {Array<{start:number, end:number}>} intervals
 * @returns {number} covered seconds (0 when there is nothing to cover)
 */
export function unionDurationSeconds(intervals) {
  const merged = mergeIntervals(intervals);
  const total = merged.reduce((sum, i) => sum + (i.end - i.start), 0);
  return Math.round(total);
}

/**
 * Groups observations into sessions.
 *
 * Rules:
 *   - Observations are processed in OCCURRENCE order, so late and out-of-order arrivals
 *     are handled correctly.
 *   - A new session starts when the gap to the previous observation exceeds
 *     `gapThresholdSeconds`.
 *   - The session duration is the UNION of its member intervals: overlapping
 *     observations are never double-counted.
 *   - Idle intervals are measured separately, so active time can be derived without
 *     pretending that idle time was productive.
 *
 * @param {Array<object>} observations
 * @param {object} [options]
 * @param {number} [options.gapThresholdSeconds]
 * @returns {Array<object>} sessions, oldest first
 */
export function buildSessions(observations = [], { gapThresholdSeconds = DEFAULT_GAP_THRESHOLD_SECONDS } = {}) {
  const intervals = observations
    .map(toInterval)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const groups = [];
  let current = null;

  for (const interval of intervals) {
    if (!current) {
      current = { intervals: [interval], end: interval.end };
      groups.push(current);
      continue;
    }

    const gap = interval.start - current.end;
    if (gap > gapThresholdSeconds) {
      current = { intervals: [interval], end: interval.end };
      groups.push(current);
      continue;
    }

    current.intervals.push(interval);
    if (interval.end > current.end) current.end = interval.end;
  }

  return groups.map((group) => {
    const memberIntervals = group.intervals.map((i) => ({ start: i.start, end: i.end }));
    const idleIntervals = group.intervals.filter((i) => i.idle).map((i) => ({ start: i.start, end: i.end }));

    const startedAt = group.intervals.reduce(
      (min, i) => (i.start < min ? i.start : min),
      group.intervals[0].start
    );
    const endedAt = group.intervals.reduce(
      (max, i) => (i.end > max ? i.end : max),
      group.intervals[0].end
    );
    const coverageSeconds = unionDurationSeconds(memberIntervals);
    const idleCoverageSeconds = unionDurationSeconds(idleIntervals);

    const dominant = pickDominantObservation(group.intervals);

    return {
      startedAt: new Date(startedAt * 1000).toISOString(),
      endedAt: new Date(endedAt * 1000).toISOString(),
      // No measured coverage means "not recorded" (null), never a numeric zero.
      durationSeconds: coverageSeconds > 0 ? coverageSeconds : null,
      idleSeconds: idleCoverageSeconds > 0 ? idleCoverageSeconds : 0,
      hasCoverage: coverageSeconds > 0,
      application: dominant?.application ?? null,
      source: dominant?.source ?? "manual",
      observationIds: group.intervals.map((i) => i.observation?.id).filter(Boolean),
    };
  });
}

/**
 * The observation that contributed the most measured time — the session's main
 * application. Ties are broken by the earliest observation, so the result is stable.
 */
function pickDominantObservation(intervals) {
  let best = null;
  let bestSeconds = -1;
  for (const interval of intervals) {
    const seconds = interval.end - interval.start;
    if (seconds > bestSeconds) {
      bestSeconds = seconds;
      best = interval.observation ?? null;
    }
  }
  return best;
}

/**
 * Recomputes the sessions that a set of observations produces, replacing the previous
 * sessions that overlap the recomputed window.
 *
 * Late events arrive after the fact: the affected window is rebuilt from the
 * observations so the durations stay correct.
 *
 * NO RECORDED TIME IS LOST: a previous session that only PARTLY overlaps the rebuilt
 * window would otherwise be dropped together with the time it covered outside the
 * window. The outside-window head and tail of such a session are carried over as
 * synthetic observations, so the total covered time is preserved. (The carried-over
 * part uses the session's span, so a session that contained internal gaps keeps its
 * total span rather than its exact union coverage — a deliberate approximation that
 * favours "no data loss" over false precision.)
 *
 * @param {Array<object>} previousSessions
 * @param {Array<object>} observations the observations in the affected window
 * @param {object} [options] same options as buildSessions
 * @returns {Array<object>} the rebuilt session set
 */
export function recomputeSessions(previousSessions = [], observations = [], options = {}) {
  const intervals = observations.map(toInterval).filter(Boolean);
  if (intervals.length === 0) return previousSessions;

  const windowStart = intervals.reduce(
    (min, i) => (i.start < min ? i.start : min),
    intervals[0].start
  );
  const windowEnd = intervals.reduce(
    (max, i) => (i.end > max ? i.end : max),
    intervals[0].end
  );

  const kept = [];
  const carryOver = [];

  for (const session of previousSessions) {
    const start = toEpochSeconds(session.startedAt);
    const end = toEpochSeconds(session.endedAt);
    if (start === null || end === null) {
      kept.push(session);
      continue;
    }

    if (end <= windowStart || start >= windowEnd) {
      kept.push(session);
      continue;
    }

    // Overlapping: keep the parts outside the rebuilt window.
    if (start < windowStart) {
      carryOver.push({
        id: `carry:${session.id}:head`,
        occurred_at: new Date(start * 1000).toISOString(),
        duration_seconds: Math.round(windowStart - start),
        is_idle: false,
        application: session.application ?? null,
        source: session.source ?? "collector",
      });
    }
    if (end > windowEnd) {
      carryOver.push({
        id: `carry:${session.id}:tail`,
        occurred_at: new Date(windowEnd * 1000).toISOString(),
        duration_seconds: Math.round(end - windowEnd),
        is_idle: false,
        application: session.application ?? null,
        source: session.source ?? "collector",
      });
    }
  }

  const rebuilt = buildSessions([...observations, ...carryOver], options);

  return [...kept, ...rebuilt].sort(
    (a, b) => toEpochSeconds(a.startedAt) - toEpochSeconds(b.startedAt)
  );
}

/**
 * Applies manual corrections to a session.
 *
 * The original values are never overwritten: the LATEST correction wins, and the
 * previous values travel with it for audit.
 *
 * @param {object} session
 * @param {Array<object>} corrections
 * @returns {object} the session with the effective values applied
 */
export function applyCorrections(session, corrections = []) {
  if (!corrections || corrections.length === 0) return session;

  const latest = [...corrections]
    .filter((c) => Number.isFinite(toEpochSeconds(c.created_at ?? c.createdAt)))
    .sort((a, b) => toEpochSeconds(a.created_at ?? a.createdAt) - toEpochSeconds(b.created_at ?? b.createdAt))
    .pop();

  if (!latest) return session;

  const startedAt = latest.corrected_started_at ?? latest.correctedStartedAt ?? session.startedAt;
  const endedAt = latest.corrected_ended_at ?? latest.correctedEndedAt ?? session.endedAt;
  const storedDuration = latest.corrected_duration_seconds ?? latest.correctedDurationSeconds ?? null;

  const startSeconds = toEpochSeconds(startedAt);
  const endSeconds = toEpochSeconds(endedAt);
  const intervalSeconds =
    startSeconds === null || endSeconds === null ? null : Math.round(endSeconds - startSeconds);

  // A correction states the interval it corrects, so the duration follows from it.
  // A stored duration that contradicts its own interval is reported, not trusted
  // silently.
  const durationSeconds =
    storedDuration === null ? intervalSeconds : storedDuration;

  return {
    ...session,
    startedAt,
    endedAt,
    durationSeconds,
    corrected: true,
    correctionReason: latest.reason ?? null,
    correctionDurationMismatch:
      storedDuration !== null &&
      intervalSeconds !== null &&
      Math.abs(storedDuration - intervalSeconds) > 1,
  };
}

/**
 * The local calendar day of an instant, in the given IANA timezone.
 *
 * Used for day bucketing so a session at 23:30 in Asia/Bangkok lands on the user's
 * local day and not on the UTC day. The implementation is shared with the rest of the
 * app (src/lib/dates.js) so the day key is defined in exactly one place.
 *
 * @param {string|number|Date} value
 * @param {string} [timeZone] IANA name, defaults to UTC
 * @returns {string|null} 'YYYY-MM-DD' in the requested timezone
 */
export function localDayKey(value, timeZone = "UTC") {
  return dayKey(value, timeZone);
}

/**
 * Groups sessions by their local day.
 *
 * @param {Array<object>} sessions
 * @param {string} [timeZone]
 * @returns {Map<string, Array<object>>} day key -> sessions
 */
export function groupSessionsByLocalDay(sessions = [], timeZone = "UTC") {
  const byDay = new Map();
  for (const session of sessions) {
    const key = localDayKey(session.startedAt, session.timezone ?? timeZone);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(session);
  }
  return byDay;
}

/**
 * Attaches a task to a session, recording HOW and HOW CONFIDENT.
 *
 * The system never invents a relationship: without a task the session stays
 * unattributed. A manual attribution is confirmed; a rule or inferred one is only a
 * suggestion until the user confirms it.
 *
 * @param {object} session
 * @param {object} attribution
 * @param {string|null} [attribution.taskId]
 * @param {string} [attribution.source] 'manual' | 'rule' | 'inferred'
 * @param {number} [attribution.confidence] 0..1
 * @returns {object} session with attribution fields applied
 */
export function attributeSession(session, { taskId = null, source = null, confidence = null } = {}) {
  if (!taskId) {
    return {
      ...session,
      taskId: null,
      attributionSource: null,
      attributionConfidence: null,
      attributionStatus: "unattributed",
    };
  }

  if (!ATTRIBUTION_SOURCES.includes(source)) {
    // A null source means "unknown": the database allows a task without a source, so
    // the domain must accept it too. Only an explicitly invalid source is an error.
    if (source !== null && source !== undefined) {
      throw new Error(`Attribution source must be one of: ${ATTRIBUTION_SOURCES.join(", ")}.`);
    }
  }

  if (confidence !== null && confidence !== undefined) {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("Attribution confidence must be a number between 0 and 1.");
    }
  }

  const status =
    source === "manual"
      ? "confirmed"
      : (confidence ?? 0) >= ATTRIBUTION_SUGGESTION_THRESHOLD
        ? "suggested"
        : "uncertain";

  return {
    ...session,
    taskId,
    attributionSource: source,
    attributionConfidence: confidence ?? null,
    attributionStatus: status,
  };
}

/**
 * Builds a MANUAL (hand-entered) session.
 *
 * WHY a manual session carries NO observations and NO idle measurement:
 *   - `observationIds` is always EMPTY. A hand-entered session has no raw event
 *     behind it: nothing was observed, so there is nothing to point at. Inventing
 *     an observation link would fabricate a measurement the system never made, and
 *     it would make the row look like it came from a collector.
 *   - `idleSeconds` is always NULL. Idle time was never MEASURED for a manual
 *     entry. Reporting 0 would claim "the user was never idle" — a measurement
 *     that does not exist — and would let `activeSeconds()` report the whole
 *     session as active. NULL means "not measured", which is the truth.
 *
 * The attribution follows the same rule as `attributeSession`: a task the user
 * picked is a CONFIRMED fact (`manual`, confidence 1), and a session without a
 * task stays unattributed — the app never invents a task relationship.
 *
 * @param {object} values
 * @param {string|Date} values.startedAt start of the entry (ISO string or Date)
 * @param {number} values.durationSeconds length of the entry in seconds (0 or more).
 *   Pass WHOLE seconds: the database stores durations in integer seconds and
 *   `insertSession` rounds the value it writes, so a fractional input would be
 *   written back as a different number than the interval it describes.
 * @param {string} [values.timezone] IANA name of the zone the entry was made in
 * @param {string|null} [values.taskId] the task the user attributed the time to
 * @param {string|null} [values.application] the application the user named
 * @returns {{
 *   startedAt: string,
 *   endedAt: string,
 *   durationSeconds: number,
 *   idleSeconds: null,
 *   source: "manual",
 *   application: string|null,
 *   timezone: string,
 *   taskId: string|null,
 *   attributionSource: "manual"|null,
 *   attributionConfidence: 1|null,
 *   observationIds: Array<string>
 * }}
 */
export function buildManualSession({
  startedAt,
  durationSeconds,
  timezone = "UTC",
  taskId = null,
  application = null,
} = {}) {
  // WHY only a string or a Date: a bare number is ambiguous (milliseconds or
  // seconds?) and guessing it would silently record a session in the wrong
  // century. A start time that cannot be read is a missing start time.
  let startMs;
  if (startedAt instanceof Date) {
    startMs = startedAt.getTime();
  } else if (typeof startedAt === "string" && startedAt.trim() !== "") {
    startMs = Date.parse(startedAt);
  } else {
    startMs = NaN;
  }
  if (!Number.isFinite(startMs)) {
    throw new Error("A start time is required.");
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error("The duration must be a number of seconds (0 or more).");
  }

  // The task is the user's own statement, so it is a confirmed attribution and
  // not a guess. Without a task the session stays unattributed.
  const hasTask = taskId !== null && taskId !== undefined && taskId !== "";
  // WHY Math.round: a fractional duration multiplied into milliseconds can land a
  // fraction of a millisecond below the true instant, which would print an ISO
  // string that is 1 ms early.
  const endedAt = new Date(Math.round(startMs + durationSeconds * 1000)).toISOString();

  return {
    startedAt: new Date(startMs).toISOString(),
    endedAt,
    // The stated duration is carried through unchanged, so the end time and the
    // duration always describe the same interval. A zero is a REAL, stated
    // duration ("I recorded an instant"), not missing data.
    durationSeconds,
    idleSeconds: null,
    source: "manual",
    application: application ?? null,
    timezone,
    taskId: hasTask ? taskId : null,
    attributionSource: hasTask ? "manual" : null,
    attributionConfidence: hasTask ? 1 : null,
    observationIds: [],
  };
}

/**
 * Active (non-idle) seconds of a session.
 *
 * Returns null when idle was never measured, or when the session has no recorded
 * duration at all, so "unknown" is never reported as "the whole session was active".
 *
 * @param {object} session
 * @returns {number|null}
 */
export function activeSeconds(session) {
  if (session?.idleSeconds === null || session?.idleSeconds === undefined) return null;
  if (session?.durationSeconds === null || session?.durationSeconds === undefined) return null;
  return Math.max(0, session.durationSeconds - session.idleSeconds);
}

/**
 * Maps an observation row to the camelCase shape the UI consumes.
 *
 * `duration_seconds` is the canonical unit (integer seconds); NULL means "not
 * recorded" and is preserved as null — never 0.
 */
export function toObservationShape(row) {
  return {
    id: row.id,
    source: row.source ?? "manual",
    occurredAt: row.occurred_at ?? null,
    ingestedAt: row.ingested_at ?? null,
    durationSeconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : Number(row.duration_seconds),
    application: row.application ?? null,
    windowTitle: row.window_title ?? null,
    isIdle: row.is_idle === true,
  };
}

/**
 * Maps a session row to the camelCase shape the UI consumes.
 *
 * `idle_seconds` NULL means idle was never measured, so active time cannot be derived;
 * `attribution_confidence` NULL means the attribution confidence is unknown.
 */
export function toSessionShape(row) {
  return {
    id: row.id,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    durationSeconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : Number(row.duration_seconds),
    idleSeconds:
      row.idle_seconds === null || row.idle_seconds === undefined
        ? null
        : Number(row.idle_seconds),
    source: row.source ?? "manual",
    application: row.application ?? null,
    timezone: row.timezone ?? "UTC",
    taskId: row.task_id ?? null,
    attributionSource: row.attribution_source ?? null,
    attributionConfidence:
      row.attribution_confidence === null || row.attribution_confidence === undefined
        ? null
        : Number(row.attribution_confidence),
    observationIds: row.observation_ids ?? [],
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}
