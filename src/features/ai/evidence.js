// Central Hub — the evidence layer: what may be shown to an AI provider.
//
// Serves MASTER_SPEC Section 7G: "Minimize and disclose what user data is sent
// to any external AI provider."
//
// WHY this module exists: the decision about what leaves the device must be made
// ONCE, in one place, and must be auditable. A provider is never handed the
// app's rows directly; it is handed an EVIDENCE PACKAGE built here, and the
// package records both what it contains and what it deliberately leaves out.
//
// THE RULES
//   - Task titles and task notes ARE included: they are the user's own words
//     about their own work, and without them an analysis cannot say what the
//     work actually was.
//   - Window titles are NOT included unless the user has explicitly opted in.
//     A window title is the content of a screen, it is the most sensitive field
//     the app holds, and MASTER_SPEC section 5 treats it as opt-in data.
//   - The email address is never included. It identifies the person, not the
//     work, and no analysis needs it.
//   - The digest identifies the exact package that was sent, so a run record
//     can later PROVE what was sent without keeping a second copy of it.
//
// This module is deliberately PURE (no React, no network, no browser APIs) and
// is imported by BOTH the browser bundle and the Supabase Edge Function, so the
// data that can leave the device is defined in exactly one place.

import { stableHash } from "../../lib/stableId.js";

/**
 * The maximum number of characters of a task note that is included.
 *
 * A note is included so the analysis knows what the work was; a long note is
 * not read in full by any analysis, and an unbounded note is an unbounded
 * transfer.
 */
export const MAX_NOTE_LENGTH = 500;

/** The maximum number of tasks described in one package. */
export const MAX_TASKS = 50;

/** The maximum number of activity entries described in one package. */
export const MAX_ACTIVITY = 100;

/**
 * The fields that are never part of a package, and why.
 *
 * The list is returned with every package so the UI can DISCLOSE it: the user
 * can see what was withheld, not only what was sent.
 */
export const ALWAYS_EXCLUDED = [
  {
    field: "auth.users.email",
    reason:
      "The email address identifies the person, not the work. No analysis needs it.",
  },
  {
    field: "work_logs.display_name",
    reason:
      "The display name identifies the person, not the work. No analysis needs it.",
  },
  {
    field: "observations.ingested_at",
    reason:
      "The ingestion time is when the app stored a record, not when the work happened.",
  },
];

/**
 * The field that is withheld unless the user opts in.
 */
export const WINDOW_TITLE_FIELD = "observations.window_title";

/**
 * Normalises a work log for a package.
 *
 * @param {object} log a work log, in either the app's camelCase shape or the
 *   database's snake_case shape
 * @returns {{id: string, title: string, note: string|null, date: string|null, seconds: number|null}}
 */
export function normaliseLog(log) {
  if (!log || typeof log !== "object") {
    return { id: "", title: "", note: null, date: null, seconds: null };
  }
  const date = log.date ?? log.log_date ?? null;
  const seconds = secondsOf(log);
  return {
    id: String(log.id ?? ""),
    title: String(log.title ?? ""),
    note: firstString(log.notes ?? log.note),
    date: typeof date === "string" ? date.slice(0, 10) : null,
    seconds: typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null,
  };
}

/**
 * The duration of a work log, in seconds.
 *
 * A log carries its duration either in seconds (`duration_seconds`) or in
 * minutes (`timeSpentMinutes`, the shape the dashboard uses). A log with
 * neither has NO recorded duration, which is null and never 0.
 *
 * @param {object} log
 * @returns {number|null}
 */
function secondsOf(log) {
  const direct = log.durationSeconds ?? log.duration_seconds;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;

  const minutes = log.timeSpentMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes)) return minutes * 60;

  return null;
}

/**
 * Normalises a task for a package.
 *
 * @param {object} task a task, in either shape
 * @returns {{id: string, title: string, note: string|null, status: string|null, dueDate: string|null, estimatedSeconds: number|null}}
 */
export function normaliseTask(task) {
  if (!task || typeof task !== "object") {
    return {
      id: "",
      title: "",
      note: null,
      status: null,
      dueDate: null,
      estimatedSeconds: null,
    };
  }
  const due = task.dueDate ?? task.due_date ?? null;
  return {
    id: String(task.id ?? ""),
    title: String(task.title ?? ""),
    note: firstString(task.description ?? task.note),
    status: firstString(task.status),
    dueDate: typeof due === "string" ? due.slice(0, 10) : null,
    estimatedSeconds:
      typeof (task.estimatedSeconds ?? task.estimated_duration_seconds) === "number"
        ? (task.estimatedSeconds ?? task.estimated_duration_seconds)
        : null,
  };
}

/**
 * Normalises an observation for a package.
 *
 * @param {object} observation an observation, in either shape
 * @returns {{id: string, occurredAt: string|null, seconds: number|null, application: string|null, windowTitle: string|null, isIdle: boolean}}
 */
export function normaliseObservation(observation) {
  if (!observation || typeof observation !== "object") {
    return {
      id: "",
      occurredAt: null,
      seconds: null,
      application: null,
      windowTitle: null,
      isIdle: false,
    };
  }
  const occurredAt = observation.occurredAt ?? observation.occurred_at ?? null;
  return {
    id: String(observation.id ?? ""),
    occurredAt: typeof occurredAt === "string" ? occurredAt : null,
    seconds:
      typeof (observation.durationSeconds ?? observation.duration_seconds) === "number"
        ? (observation.durationSeconds ?? observation.duration_seconds)
        : null,
    application: firstString(observation.application),
    windowTitle: firstString(observation.window_title ?? observation.windowTitle),
    isIdle: observation.isIdle === true || observation.is_idle === true,
  };
}

/**
 * Builds the evidence package.
 *
 * @param {object} options
 * @param {Array<object>} [options.logs] the user's work logs
 * @param {Array<object>} [options.tasks] the user's tasks
 * @param {Array<object>} [options.observations] the user's activity observations
 * @param {string|null} [options.from] ISO date, inclusive
 * @param {string|null} [options.to] ISO date, exclusive
 * @param {boolean} [options.includeWindowTitles] the user's opt-in
 * @returns {{range: object, totals: object, perDay: Array, tasks: Array, activity: Array, excluded: Array, digest: string}}
 */
export function buildEvidence({
  logs = [],
  tasks = [],
  observations = [],
  from = null,
  to = null,
  includeWindowTitles = false,
} = {}) {
  const normalisedLogs = (Array.isArray(logs) ? logs : []).map(normaliseLog);
  const normalisedTasks = (Array.isArray(tasks) ? tasks : []).map(normaliseTask);
  const normalisedObservations = (Array.isArray(observations) ? observations : []).map(
    normaliseObservation
  );

  // Only activity inside the range is described, so a package is never larger
  // than the question it answers.
  const inRange = (timestamp) => {
    if (!timestamp) return false;
    if (from && timestamp < from) return false;
    if (to && timestamp >= to) return false;
    return true;
  };

  const rangedObservations = normalisedObservations.filter((observation) =>
    inRange(observation.occurredAt)
  );

  const recordedSeconds = normalisedLogs.reduce(
    (sum, log) => (log.seconds ? sum + log.seconds : sum),
    0
  );
  const entriesWithDuration = normalisedLogs.filter(
    (log) => log.seconds !== null
  ).length;

  const perDay = summarisePerDay(normalisedLogs);
  const days = perDay.length;

  const describedTasks = normalisedTasks.slice(0, MAX_TASKS).map((task) => ({
    id: task.id,
    title: task.title,
    note: task.note === null ? null : task.note.slice(0, MAX_NOTE_LENGTH),
    status: task.status,
    dueDate: task.dueDate,
    estimatedSeconds: task.estimatedSeconds,
  }));

  const describedActivity = rangedObservations.slice(0, MAX_ACTIVITY).map((observation) => ({
    id: observation.id,
    occurredAt: observation.occurredAt,
    seconds: observation.seconds,
    application: observation.application,
    isIdle: observation.isIdle,
    // The window title is only ever present when the user opted in.
    ...(includeWindowTitles
      ? { windowTitle: observation.windowTitle }
      : {}),
  }));

  const excluded = [...ALWAYS_EXCLUDED];
  if (!includeWindowTitles) {
    excluded.push({
      field: WINDOW_TITLE_FIELD,
      reason:
        "Window titles are withheld unless you turn them on in Settings. They are the content of your screens.",
    });
  }

  const packageBody = {
    range: { from, to },
    totals: {
      logEntries: normalisedLogs.length,
      entriesWithDuration,
      recordedSeconds,
      tasks: normalisedTasks.length,
      observations: rangedObservations.length,
      days,
    },
    perDay,
    tasks: describedTasks,
    activity: describedActivity,
  };

  return {
    ...packageBody,
    excluded,
    digest: stableHash(JSON.stringify(packageBody)),
  };
}

/**
 * Summarises the work logs per calendar day.
 *
 * @param {Array<{date: string|null, seconds: number|null}>} logs
 * @returns {Array<{date: string, entries: number, seconds: number}>}
 */
function summarisePerDay(logs) {
  const byDay = new Map();
  for (const log of logs) {
    if (!log.date) continue;
    const bucket = byDay.get(log.date) ?? { date: log.date, entries: 0, seconds: 0 };
    bucket.entries += 1;
    if (log.seconds) bucket.seconds += log.seconds;
    byDay.set(log.date, bucket);
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * The first non-empty string of the given values, or null.
 *
 * @param {...unknown} values
 * @returns {string|null}
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
