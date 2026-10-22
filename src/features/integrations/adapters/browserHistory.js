// Central Hub — adapter: browser history on this computer.
//
// Reads visits Chrome has already recorded. The collector reduces each visit to
// a host and, when Chrome measured one, a duration. The full URL, the query
// string, and the page title never enter the payload.
//
// A duration of 0 is Chrome's "not measured", so it is stored as null, not as
// zero seconds. A duration longer than 12 hours is treated the same way: Chrome
// sometimes leaves a tab's clock running, and that figure is not a visit length.

import { deterministicUuid } from "../ids.js";

export const ADAPTER_ID = "browser";
export const OBSERVATION_SOURCE = "import";
const MAX_DURATION_SECONDS = 12 * 60 * 60;

/**
 * @param {string} text collector payload
 * @returns {{records: Array<{occurredAt: string, host: string, durationSeconds: number|null}>}}
 */
export function parse(text) {
  const data = readPayload(text);
  return {
    records: data.records.map((record, index) => ({
      occurredAt: readTimestamp(record?.occurred_at, index),
      host: readHost(record?.host, index),
      durationSeconds: readDuration(record?.duration_seconds, index),
    })),
  };
}

/**
 * @param {Array<{occurredAt: string, host: string, durationSeconds: number|null}>} records
 */
export function toObservations(records = []) {
  return records.map((record) => ({
    id: deterministicUuid(
      `${ADAPTER_ID}|${record.occurredAt}|${record.host}|${record.durationSeconds ?? ""}`
    ),
    occurredAt: record.occurredAt,
    durationSeconds: record.durationSeconds,
    application: record.host,
    windowTitle: null,
    isIdle: false,
    source: OBSERVATION_SOURCE,
  }));
}

export const browserHistoryAdapter = {
  id: ADAPTER_ID,
  label: "Browser",
  summary:
    "Imports recent site visits from the Chrome history already stored on this computer.",
  implemented: true,
  collection: "local",
  removalPolicy:
    "Disconnecting deletes the observations this sync imported. Chrome's history database is left untouched.",
  documentation: {
    canAccess:
      "The host name of sites you visited in Chrome on this computer, the time of the visit, and the duration when Chrome recorded one. Page titles, URL paths, and query strings are not read into the app.",
    permissions:
      "The collector runs beside the app on this computer and reads only Chrome's History database. It starts when you press Sync. An open tab is not treated as study.",
    authentication:
      "None. There is no Google account connection and no token. The read uses the history file already on this computer.",
    reads:
      "Reads the visits table in Chrome's Default profile. Each visit is reduced to its host before it leaves the collector.",
    writes:
      "Writes observations in your account. It does not write back to Chrome.",
    synchronisation:
      "Runs when you press Sync. The latest 400 visits are sent. Pressing Sync again inserts nothing new for visits already imported.",
    deduplication:
      "Each observation id is derived from the visit time, the host, and the duration, then scoped to this connection, so the same visit is not stored twice.",
    errors:
      "If the history database is missing or a record is malformed, the sync fails with the reason and previously imported visits stay as they were.",
    retention:
      "Imported observations stay until you disconnect this connector or delete them. A missing duration stays missing.",
    removalOnDisconnect:
      "Disconnecting deletes the observations linked to this connection. Chrome's History file is not deleted.",
  },
  parse,
  toObservations,
};

function readPayload(text) {
  if (typeof text !== "string") {
    throw new Error("Browser history must be read as text before it can be parsed.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Browser history is not valid JSON: ${error.message}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.records)) {
    throw new Error('Browser history must be a JSON object with a "records" array.');
  }
  return data;
}

function readTimestamp(value, index) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Record ${index} has no valid "occurred_at" timestamp.`);
  }
  return new Date(value).toISOString();
}

function readHost(value, index) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Record ${index} has no host.`);
  }
  const host = value.trim().toLowerCase();
  if (host.includes("/") || host.includes(" ") || host.includes("?") || host.includes("#")) {
    throw new Error(`Record ${index} must be a host name, not a URL.`);
  }
  return host;
}

function readDuration(value, index) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Record ${index} has an invalid duration.`);
  }
  if (value < 0) {
    throw new Error(`Record ${index} has a negative duration.`);
  }
  if (value === 0 || value > MAX_DURATION_SECONDS) return null;
  return Math.round(value);
}
