// Central Hub — coding-time rules.
//
// The VS Code / Cursor extension and the app both use this module. It has no
// dependency on the editor API or on React, so the idle rule, the session
// grouping and the overlap rule can be checked with plain Node assertions.
//
// What is recorded: active time in an editor. Time is the span between two
// observed activities (an edit, a selection change, a file switch) when that
// span is inside the idle window. Time after the last activity, and time while
// the editor is unfocused or paused, is not counted. A lone activity with no
// following activity inside the window has no measured span, so nothing is
// stored for it — missing stays missing, it is not written as zero.
//
// What is not recorded: file contents, full paths, window titles, keystrokes.

import { deterministicUuid } from "./stableId.js";

/** Adapter id. One connection per user, matching public.integrations.provider. */
export const CODING_PROVIDER = "coding_tracker";

/** The only activity kind this increment writes. Later sources extend the check. */
export const ACTIVITY_KIND = "coding";

/** Editors this extension can tell apart. Cursor is detected; every other host is VS Code. */
export const EDITORS = ["cursor", "vscode"];

/** How long one stored heartbeat covers before the next one starts. */
export const DEFAULT_HEARTBEAT_SECONDS = 120;

/** A gap longer than this is idle: it is not counted, and it ends the slice. */
export const DEFAULT_IDLE_SECONDS = 120;

/** Sessions split when the gap between heartbeats is larger than this. */
export const DEFAULT_GAP_SECONDS = 120;

const HEARTBEAT_MIN = 15;
const HEARTBEAT_MAX = 300;
const IDLE_MIN = 30;
const IDLE_MAX = 1800;

/**
 * Cursor reports "Cursor". Every other VS Code-compatible host is recorded as
 * VS Code, which is the truthful bucket for Visual Studio Code and its forks.
 *
 * @param {string} appName `vscode.env.appName`
 * @returns {"cursor"|"vscode"}
 */
export function detectEditor(appName) {
  const value = String(appName ?? "").toLowerCase();
  if (value.includes("cursor")) return "cursor";
  return "vscode";
}

/**
 * The label shown in the app.
 *
 * @param {string|null} editor
 * @returns {string}
 */
export function editorLabel(editor) {
  if (editor === "cursor") return "Cursor";
  if (editor === "vscode") return "VS Code";
  return "Unknown editor";
}

/**
 * The application name stored on the observation, matching the editor.
 *
 * @param {string|null} editor
 * @returns {string|null}
 */
export function applicationName(editor) {
  if (editor === "cursor") return "Cursor";
  if (editor === "vscode") return "Visual Studio Code";
  return null;
}

/**
 * The last path segment, or null when the value is empty or climbs out with "..".
 *
 * Full paths stay on the editor machine. The stored value is a label.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function basenameLabel(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.includes("..")) return null;
  const parts = text.split(/[/\\]/).filter((part) => part && part !== ".");
  const base = parts.length > 0 ? parts[parts.length - 1] : "";
  if (!base) return null;
  return base.length > 255 ? base.slice(0, 255) : base;
}

/** @param {string|null|undefined} value */
export function projectLabel(value) {
  return basenameLabel(value);
}

/** @param {string|null|undefined} value */
export function fileLabel(value) {
  return basenameLabel(value);
}

/**
 * A language id such as "javascript", or null.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function languageLabel(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || text.includes("/") || text.includes("\\") || text.includes("..")) return null;
  return text.length > 64 ? text.slice(0, 64) : text;
}

/**
 * @param {object} [seed]
 * @returns {object} the tracker's starting state
 */
export function initialTrackerState(seed = {}) {
  const editor = seed.editor === "cursor" ? "cursor" : "vscode";
  return {
    paused: seed.paused === true,
    focused: seed.focused !== false,
    editor,
    projectName: projectLabel(seed.projectName),
    fileName: fileLabel(seed.fileName),
    language: languageLabel(seed.language),
    lastActivityAt: null,
    sliceStart: null,
    accumulated: 0,
  };
}

/**
 * Advances the tracker by one event and returns any heartbeats the event closed.
 *
 * Events: activity, tick, blur, focus, pause, resume.
 * `at` is epoch seconds, epoch milliseconds, an ISO string, or a Date.
 *
 * @param {object} state
 * @param {object} event
 * @param {object} [options]
 * @param {number} [options.heartbeatSeconds]
 * @param {number} [options.idleSeconds]
 * @returns {{state: object, heartbeats: Array<object>}}
 */
export function reduceTracker(state, event, options = {}) {
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

  if (event?.type === "pause") {
    flushAll(draft, heartbeats, heartbeatSeconds);
    draft.paused = true;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  if (event?.type === "resume") {
    draft.paused = false;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  if (event?.type === "focus") {
    draft.focused = true;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  if (event?.type === "blur") {
    flushAll(draft, heartbeats, heartbeatSeconds);
    draft.focused = false;
    draft.lastActivityAt = null;
    return { state: draft, heartbeats };
  }

  if (at == null) return { state: draft, heartbeats };

  if (event?.type === "tick") {
    if (!draft.paused && draft.focused && draft.lastActivityAt != null) {
      if (at - draft.lastActivityAt > idleSeconds) {
        flushAll(draft, heartbeats, heartbeatSeconds);
        draft.lastActivityAt = null;
      }
    }
    return { state: draft, heartbeats };
  }

  if (event?.type === "activity") {
    const next = readContext(event, draft);
    if (draft.paused || !draft.focused) {
      draft.editor = next.editor;
      draft.projectName = next.projectName;
      draft.fileName = next.fileName;
      draft.language = next.language;
      return { state: draft, heartbeats };
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

    draft.editor = next.editor;
    draft.projectName = next.projectName;
    draft.fileName = next.fileName;
    draft.language = next.language;
    draft.lastActivityAt = at;
    return { state: draft, heartbeats };
  }

  return { state: draft, heartbeats };
}

/**
 * Groups heartbeats into sessions by editor and project.
 *
 * A new session starts when the editor changes, the project changes, or the gap
 * from the previous heartbeat's end exceeds `gapSeconds`. File and language
 * changes stay inside the session and are listed on it.
 *
 * @param {Array<object>} heartbeats
 * @param {object} [options]
 * @param {number} [options.gapSeconds]
 * @returns {Array<object>} sessions, oldest first
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
      beat.editor !== current.editor ||
      beat.projectName !== current.projectName ||
      gap > gapSeconds;

    if (split) {
      current = {
        editor: beat.editor,
        projectName: beat.projectName,
        beats: [beat],
        end: beat.end,
      };
      groups.push(current);
      continue;
    }

    current.beats.push(beat);
    if (beat.end > current.end) current.end = beat.end;
  }

  return groups.map(toSession);
}

/**
 * Active seconds covered by these heartbeats.
 *
 * Overlapping intervals are counted once. Null means nothing was measured —
 * never zero. Idle heartbeats are left out.
 *
 * @param {Array<object>} heartbeats
 * @returns {number|null}
 */
export function coveredSeconds(heartbeats = []) {
  const intervals = [];
  for (const beat of heartbeats) {
    const normalized = normalizeHeartbeat(beat);
    if (!normalized || normalized.isIdle || normalized.durationSeconds == null) continue;
    if (normalized.durationSeconds <= 0) continue;
    intervals.push({ start: normalized.start, end: normalized.end });
  }
  if (intervals.length === 0) return null;
  const total = unionSeconds(intervals);
  return total > 0 ? total : null;
}

/**
 * Covered seconds per group. The key function receives a normalised heartbeat.
 *
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
 * Normalises an app heartbeat or a database row into one shape.
 *
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
  const editor = value.editor === "cursor" || value.editor === "vscode" ? value.editor : null;
  return {
    id: value.id ?? null,
    occurredAt: new Date(Math.round(start * 1000)).toISOString(),
    start,
    durationSeconds: duration != null && duration > 0 ? duration : duration === 0 ? 0 : null,
    end: start + (duration != null && duration > 0 ? duration : 0),
    editor,
    projectName: value.projectName ?? value.project_name ?? null,
    fileName: value.fileName ?? value.file_name ?? null,
    language: value.language ?? null,
    isIdle: value.isIdle === true || value.is_idle === true,
    source: value.source ?? "collector",
    activityKind: value.activityKind ?? value.activity_kind ?? ACTIVITY_KIND,
    application: value.application ?? applicationName(editor),
  };
}

/**
 * Database rows to the heartbeat shape `foldHeartbeats` accepts.
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function heartbeatsFromRows(rows = []) {
  return rows.map((row) => normalizeHeartbeat(row)).filter(Boolean);
}

/**
 * The identity of a heartbeat before it is scoped to a connection.
 *
 * @param {object} heartbeat
 * @returns {string}
 */
export function heartbeatKey(heartbeat) {
  const normalized = normalizeHeartbeat(heartbeat) ?? heartbeat;
  return [
    normalized.editor ?? "",
    normalized.projectName ?? "",
    normalized.fileName ?? "",
    normalized.language ?? "",
    normalized.occurredAt ?? "",
    normalized.durationSeconds ?? "",
  ].join("|");
}

/**
 * A deterministic observation id, scoped to the connection that sends it.
 *
 * The same heartbeat sent twice by the same connection collides on the primary
 * key and is stored once. Two connections never share an id.
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
  const active = coveredSeconds(group.beats);
  const files = fileBreakdown(group.beats);
  return {
    id: deterministicUuid(
      `coding-session|${group.editor ?? ""}|${group.projectName ?? ""}|${new Date(Math.round(start * 1000)).toISOString()}`
    ),
    startedAt: new Date(Math.round(start * 1000)).toISOString(),
    endedAt: new Date(Math.round(end * 1000)).toISOString(),
    durationSeconds: active,
    editor: group.editor,
    projectName: group.projectName,
    files,
    heartbeatCount: group.beats.length,
  };
}

function fileBreakdown(beats) {
  const groups = new Map();
  for (const beat of beats) {
    const key = `${beat.fileName ?? ""}|${beat.language ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(beat);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const [fileName, language] = key.split("|");
      return {
        fileName: fileName || null,
        language: language || null,
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
  const base = initialTrackerState();
  return {
    ...base,
    ...state,
    paused: state?.paused === true,
    focused: state?.focused !== false,
    accumulated: Number.isFinite(state?.accumulated) ? state.accumulated : 0,
    sliceStart: Number.isFinite(state?.sliceStart) ? state.sliceStart : null,
    lastActivityAt: Number.isFinite(state?.lastActivityAt) ? state.lastActivityAt : null,
  };
}

function readContext(event, fallback) {
  const editor =
    event.editor === "cursor" || event.editor === "vscode" ? event.editor : fallback.editor;
  return {
    editor,
    projectName: event.projectName !== undefined ? projectLabel(event.projectName) : fallback.projectName,
    fileName: event.fileName !== undefined ? fileLabel(event.fileName) : fallback.fileName,
    language: event.language !== undefined ? languageLabel(event.language) : fallback.language,
  };
}

function sameContext(state, next) {
  return (
    state.editor === next.editor &&
    state.projectName === next.projectName &&
    state.fileName === next.fileName &&
    state.language === next.language
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
  if (duration < 1 || state.sliceStart == null) return;
  const occurredAt = new Date(Math.round(state.sliceStart * 1000)).toISOString();
  heartbeats.push({
    occurredAt,
    durationSeconds: duration,
    editor: state.editor,
    projectName: state.projectName,
    fileName: state.fileName,
    language: state.language,
    isIdle: false,
    source: "collector",
    activityKind: ACTIVITY_KIND,
    application: applicationName(state.editor),
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
