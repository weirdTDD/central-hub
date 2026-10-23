// Sentral Hub — learning-time rules.
//
// The browser extension and the app both use this module. It has no dependency
// on the extension API or on React, so the allowlist, the idle rule, and the
// session grouping can be checked with plain Node assertions.
//
// What is recorded: active time on an allowlisted learning site, while the
// browser window is focused and the browser reports the user as active.
// Time is the span between those observations. Idle time, time in another
// window, and time on any other site is not counted.
//
// What is not recorded: the URL, the query string, sites that are not on the
// allowlist, keystrokes, or page contents.

import { deterministicUuid } from "./stableId.js";
import {
  ACTIVITY_KIND,
  DEFAULT_GAP_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_IDLE_SECONDS,
  describeTrackedPage,
  isHostname,
  sanitizeLabel,
  sanitizeTitle,
  sanitizeTrackLabel,
} from "./sites.js";

export {
  ACTIVITY_KIND,
  DEFAULT_GAP_SECONDS,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_IDLE_SECONDS,
};

const HEARTBEAT_MIN = 15;
const HEARTBEAT_MAX = 300;
const IDLE_MIN = 15;
const IDLE_MAX = 1800;

/**
 * @param {object} [seed]
 * @returns {object}
 */
export function initialLearningState(seed = {}) {
  return {
    paused: seed.paused === true,
    focused: seed.focused === true,
    siteHost: null,
    siteLabel: null,
    courseLabel: null,
    lessonLabel: null,
    pageTitle: null,
    lastActivityAt: null,
    sliceStart: null,
    accumulated: 0,
  };
}

/**
 * Turns one browser sample into a tracker event.
 *
 * The event never carries a URL. A page that is not allowlisted, an unfocused
 * window, and an idle user all produce an event that stops the clock.
 *
 * @param {object} sample
 * @returns {object}
 */
export function observationEvent(sample = {}) {
  const at = sample.at;
  if (sample.paused === true) return { type: "noop", at };
  if (sample.idleState !== "active") return { type: "idle", at };
  if (!sample.focused) return { type: "blur", at, bridge: true };
  const described = describeTrackedPage(sample.url, sample.sites, sample.title);
  if (!described) return { type: "leave", at, bridge: true };
  return { type: "activity", at, ...described };
}

/**
 * Advances the tracker by one event and returns any heartbeats the event closed.
 *
 * @param {object} state
 * @param {object} event
 * @param {object} [options]
 * @returns {{state: object, heartbeats: Array<object>}}
 */
export function reduceLearning(state, event, options = {}) {
  const heartbeatSeconds = clamp(
    options.heartbeatSeconds,
    HEARTBEAT_MIN,
    HEARTBEAT_MAX,
    DEFAULT_HEARTBEAT_SECONDS
  );
  const idleSeconds = clamp(options.idleSeconds, IDLE_MIN, IDLE_MAX, DEFAULT_IDLE_SECONDS);
  const draft = cloneState(state);
  const heartbeats = [];
  const at = epochSeconds(event?.at);

  if (!event || event.type === "noop") return { state: draft, heartbeats };

  if (event.type === "pause") {
    flushAll(draft, heartbeats, heartbeatSeconds);
    draft.paused = true;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  if (event.type === "resume") {
    draft.paused = false;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  if (event.type === "focus") {
    draft.focused = true;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  // A sample that arrives after a newer one must not rewind the clock or flush
  // a span that a later sample already continued.
  if (at != null && draft.lastActivityAt != null && at < draft.lastActivityAt) {
    return { state: draft, heartbeats };
  }

  if (event.type === "blur" || event.type === "leave" || event.type === "idle") {
    // Leaving or blurring can keep the short gap since the last sample, because
    // that sample still saw the user on the learning page. Idle does not: the
    // detector has already waited out the idle window, and that wait is not
    // study time. A gap longer than one heartbeat is not bridged either — the
    // sampler should have seen it, so a long gap is treated as missing.
    const cap = event.type === "idle" ? 0 : heartbeatSeconds;
    if (
      event.bridge &&
      cap > 0 &&
      at != null &&
      !draft.paused &&
      draft.focused &&
      draft.lastActivityAt != null
    ) {
      const gap = at - draft.lastActivityAt;
      if (gap > 0 && gap <= cap && gap <= idleSeconds) addGap(draft, draft.lastActivityAt, at);
    }
    flushAll(draft, heartbeats, heartbeatSeconds);
    draft.lastActivityAt = null;
    if (event.type === "blur") draft.focused = false;
    return { state: draft, heartbeats };
  }

  if (at == null) return { state: draft, heartbeats };

  if (event.type === "tick") {
    if (!draft.paused && draft.focused && draft.lastActivityAt != null && at - draft.lastActivityAt > idleSeconds) {
      flushAll(draft, heartbeats, heartbeatSeconds);
      draft.lastActivityAt = null;
    }
    return { state: draft, heartbeats };
  }

  if (event.type === "activity") {
    if (draft.paused) return { state: draft, heartbeats };
    const next = readContext(event);
    if (!next.siteHost) return { state: draft, heartbeats };
    // An activity event means the window is focused again. The time spent away
    // is not part of this span, so a resume does not bridge the gap.
    if (!draft.focused) {
      draft.focused = true;
      draft.lastActivityAt = null;
    }
    const changed = !sameContext(draft, next);
    const bridged =
      draft.lastActivityAt != null &&
      at >= draft.lastActivityAt &&
      at - draft.lastActivityAt <= idleSeconds;
    if (bridged) {
      addGap(draft, draft.lastActivityAt, at);
      if (changed) flushAll(draft, heartbeats, heartbeatSeconds);
      else drain(draft, heartbeats, heartbeatSeconds, false);
    } else if (draft.accumulated > 0) {
      flushAll(draft, heartbeats, heartbeatSeconds);
    }
    draft.siteHost = next.siteHost;
    draft.siteLabel = next.siteLabel;
    draft.courseLabel = next.courseLabel;
    draft.lessonLabel = next.lessonLabel;
    draft.pageTitle = next.pageTitle;
    draft.lastActivityAt = at;
    return { state: draft, heartbeats };
  }

  return { state: draft, heartbeats };
}

/**
 * Groups heartbeats into sessions by site and course.
 *
 * A new session starts when the site changes, the course changes, or the gap
 * from the previous heartbeat's end exceeds `gapSeconds`. Lesson changes stay
 * inside the session and are listed on it.
 *
 * @param {Array<object>} heartbeats
 * @param {object} [options]
 * @returns {Array<object>}
 */
export function foldHeartbeats(heartbeats = [], { gapSeconds = DEFAULT_GAP_SECONDS } = {}) {
  const beats = heartbeats
    .map(normalizeHeartbeat)
    .filter((beat) => beat && beat.start != null && !beat.isIdle)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const groups = [];
  let current = null;
  for (const beat of beats) {
    const gap = current ? beat.start - current.end : 0;
    const split =
      !current ||
      beat.siteHost !== current.siteHost ||
      beat.courseLabel !== current.courseLabel ||
      gap > gapSeconds;
    if (split) {
      current = {
        siteHost: beat.siteHost,
        siteLabel: beat.siteLabel,
        courseLabel: beat.courseLabel,
        beats: [beat],
        end: beat.end,
      };
      groups.push(current);
      continue;
    }
    current.beats.push(beat);
    if (beat.end > current.end) current.end = beat.end;
    if (!current.siteLabel && beat.siteLabel) current.siteLabel = beat.siteLabel;
  }
  return groups.map(toSession);
}

/**
 * Active seconds covered by these heartbeats. Overlaps count once.
 * Null means nothing was measured — never zero.
 *
 * @param {Array<object>} heartbeats
 * @returns {number|null}
 */
export function coveredSeconds(heartbeats = []) {
  const intervals = [];
  for (const beat of heartbeats) {
    const normalized = normalizeHeartbeat(beat);
    if (!normalized || normalized.isIdle || !(normalized.durationSeconds > 0)) continue;
    intervals.push({ start: normalized.start, end: normalized.end });
  }
  if (intervals.length === 0) return null;
  const total = unionSeconds(intervals);
  return total > 0 ? total : null;
}

/**
 * @param {Array<object>} heartbeats
 * @param {(beat: object) => string} keyOf
 * @returns {Array<{key: string, activeSeconds: number|null, heartbeatCount: number}>}
 */
export function groupedCoveredSeconds(heartbeats = [], keyOf) {
  const groups = new Map();
  for (const beat of heartbeats) {
    const normalized = normalizeHeartbeat(beat);
    if (!normalized) continue;
    const key = keyOf(normalized);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(beat);
  }
  return [...groups.entries()].map(([key, beats]) => ({
    key,
    activeSeconds: coveredSeconds(beats),
    heartbeatCount: beats.length,
  }));
}

/**
 * @param {object} value
 * @returns {object|null}
 */
export function normalizeHeartbeat(value) {
  if (!value || typeof value !== "object") return null;
  const start = epochSeconds(value.occurredAt ?? value.occurred_at);
  if (start == null) return null;
  const rawDuration = value.durationSeconds ?? value.duration_seconds;
  const duration =
    rawDuration == null || rawDuration === ""
      ? null
      : Number.isFinite(Number(rawDuration))
        ? Math.round(Number(rawDuration))
        : null;
  const siteHost = isHostname(value.siteHost ?? value.site_host) ? value.siteHost ?? value.site_host : null;
  const siteLabel = sanitizeLabel(value.siteLabel ?? value.site_label ?? value.application) || siteHost;
  return {
    id: value.id ?? null,
    occurredAt: new Date(Math.round(start * 1000)).toISOString(),
    start,
    durationSeconds: duration != null && duration > 0 ? duration : duration === 0 ? 0 : null,
    end: start + (duration != null && duration > 0 ? duration : 0),
    siteHost,
    siteLabel,
    courseLabel: sanitizeTrackLabel(value.courseLabel ?? value.course_label),
    lessonLabel: sanitizeTrackLabel(value.lessonLabel ?? value.lesson_label),
    pageTitle: sanitizeTitle(value.pageTitle ?? value.page_title),
    isIdle: value.isIdle === true || value.is_idle === true,
    source: value.source ?? "collector",
    activityKind: value.activityKind ?? value.activity_kind ?? ACTIVITY_KIND,
    application: siteLabel,
  };
}

/**
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function heartbeatsFromRows(rows = []) {
  return rows.map((row) => normalizeHeartbeat(row)).filter(Boolean);
}

/**
 * @param {object} heartbeat
 * @returns {string}
 */
export function heartbeatKey(heartbeat) {
  const normalized = normalizeHeartbeat(heartbeat) ?? heartbeat ?? {};
  return [
    normalized.siteHost ?? "",
    normalized.courseLabel ?? "",
    normalized.lessonLabel ?? "",
    normalized.pageTitle ?? "",
    normalized.occurredAt ?? "",
    normalized.durationSeconds ?? "",
  ].join("|");
}

/**
 * A deterministic observation id, scoped to the connection that sends it.
 *
 * @param {string} connectionId
 * @param {object} heartbeat
 * @returns {string}
 */
export function scopeHeartbeatId(connectionId, heartbeat) {
  return deterministicUuid(`${connectionId}|${heartbeatKey(heartbeat)}`);
}

function toSession(group) {
  const start = group.beats.reduce((min, beat) => (beat.start < min ? beat.start : min), group.beats[0].start);
  const end = group.beats.reduce((max, beat) => (beat.end > max ? beat.end : max), group.beats[0].end);
  return {
    id: deterministicUuid(
      `learning-session|${group.siteHost ?? ""}|${group.courseLabel ?? ""}|${new Date(Math.round(start * 1000)).toISOString()}`
    ),
    startedAt: new Date(Math.round(start * 1000)).toISOString(),
    endedAt: new Date(Math.round(end * 1000)).toISOString(),
    durationSeconds: coveredSeconds(group.beats),
    siteHost: group.siteHost,
    siteLabel: group.siteLabel,
    courseLabel: group.courseLabel,
    lessons: lessonBreakdown(group.beats),
    heartbeatCount: group.beats.length,
  };
}

function lessonBreakdown(beats) {
  const groups = new Map();
  for (const beat of beats) {
    const key = `${beat.lessonLabel ?? ""}|${beat.pageTitle ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(beat);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [lessonLabel, pageTitle] = key.split("|");
      return {
        lessonLabel: lessonLabel || null,
        pageTitle: pageTitle || null,
        durationSeconds: coveredSeconds(group),
      };
    })
    .sort((a, b) => (b.durationSeconds ?? -1) - (a.durationSeconds ?? -1));
}

function unionSeconds(intervals) {
  const sorted = intervals
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start)
    .map((interval) => ({ start: interval.start, end: interval.end }))
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
  return Math.round(merged.reduce((sum, interval) => sum + (interval.end - interval.start), 0));
}

function cloneState(state) {
  const base = initialLearningState();
  return {
    ...base,
    paused: state?.paused === true,
    focused: state?.focused === true,
    siteHost: state?.siteHost ?? null,
    siteLabel: state?.siteLabel ?? null,
    courseLabel: state?.courseLabel ?? null,
    lessonLabel: state?.lessonLabel ?? null,
    pageTitle: state?.pageTitle ?? null,
    accumulated: Number.isFinite(state?.accumulated) ? state.accumulated : 0,
    sliceStart: Number.isFinite(state?.sliceStart) ? state.sliceStart : null,
    lastActivityAt: Number.isFinite(state?.lastActivityAt) ? state.lastActivityAt : null,
  };
}

function readContext(event) {
  const siteHost = isHostname(event.siteHost) ? event.siteHost : null;
  return {
    siteHost,
    siteLabel: sanitizeLabel(event.siteLabel) || siteHost,
    courseLabel: sanitizeTrackLabel(event.courseLabel),
    lessonLabel: sanitizeTrackLabel(event.lessonLabel),
    pageTitle: sanitizeTitle(event.pageTitle),
  };
}

function sameContext(state, next) {
  return (
    state.siteHost === next.siteHost &&
    state.siteLabel === next.siteLabel &&
    state.courseLabel === next.courseLabel &&
    state.lessonLabel === next.lessonLabel
  );
}

function addGap(state, from, to) {
  const delta = to - from;
  if (!(delta > 0)) return;
  if (state.sliceStart == null) state.sliceStart = from;
  state.accumulated += delta;
}

function flushAll(state, heartbeats, heartbeatSeconds) {
  drain(state, heartbeats, heartbeatSeconds, true);
  state.sliceStart = null;
  state.accumulated = 0;
}

function drain(state, heartbeats, heartbeatSeconds, flushRemainder) {
  while (state.accumulated >= heartbeatSeconds && state.sliceStart != null) {
    pushHeartbeat(state, heartbeats, heartbeatSeconds);
    state.sliceStart += heartbeatSeconds;
    state.accumulated -= heartbeatSeconds;
  }
  if (flushRemainder && state.sliceStart != null && state.accumulated >= 1) {
    pushHeartbeat(state, heartbeats, state.accumulated);
  }
}

function pushHeartbeat(state, heartbeats, durationSeconds) {
  const duration = Math.round(durationSeconds);
  if (duration < 1 || state.sliceStart == null || !state.siteHost) return;
  heartbeats.push({
    occurredAt: new Date(Math.round(state.sliceStart * 1000)).toISOString(),
    durationSeconds: duration,
    siteHost: state.siteHost,
    siteLabel: state.siteLabel,
    courseLabel: state.courseLabel,
    lessonLabel: state.lessonLabel,
    pageTitle: state.pageTitle,
    isIdle: false,
    source: "collector",
    activityKind: ACTIVITY_KIND,
    application: state.siteLabel,
  });
}

function epochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e11 ? value / 1000 : value;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms / 1000 : null;
  }
  return null;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
