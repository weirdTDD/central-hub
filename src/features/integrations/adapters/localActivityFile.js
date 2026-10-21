// Central Hub — adapter: local activity file.
//
// An adapter is an INDEPENDENT, DOCUMENTED bridge between an outside source of
// activity and the app's observations. This one is deliberately the smallest
// possible bridge: the user picks a file from their own machine, the app reads
// it, and the records become observations. No network, no third party, no
// credentials, no background agent.
//
// ACCEPTED FILE FORMAT (JSON, UTF-8). Either shape is accepted:
//
//   {
//     "version": 1,
//     "source": "any-label-you-like",
//     "records": [
//       {
//         "occurred_at": "2026-10-20T09:00:00.000Z",  // REQUIRED, ISO-8601
//         "duration_seconds": 900,                      // optional, >= 0
//         "application": "Visual Studio Code",         // optional
//         "window_title": "src/lib/tracking.js",        // optional
//         "idle": false                                 // optional
//       }
//     ]
//   }
//
//   [
//     { "occurred_at": "2026-10-20T09:00:00.000Z", "duration_seconds": 900 }
//   ]
//
// Field rules:
//   - `occurred_at`  REQUIRED. An ISO-8601 timestamp that can be parsed. A record
//                    without one makes the WHOLE import fail.
//   - `duration_seconds` optional. A number of seconds >= 0, stored in whole
//                    seconds (the app's one unit). When it is absent the
//                    observation has NO recorded duration (null) — never 0.
//   - `application`  optional string. Absent -> null.
//   - `window_title` optional string. Absent -> null.
//   - `idle`         optional boolean. Absent -> false.
//   - any other field is ignored, so a file exported by another tool can carry
//     extra metadata without breaking the import.
//   - `occurred_at` is normalised to UTC ISO-8601, so the same instant written in
//     two different time zones produces the same observation.
//
// A malformed file fails the WHOLE run with a message that names the offending
// record, and nothing is written: previously imported data is never touched by a
// failed import.
//
// Deduplication: the observation id is derived from the record itself, so
// re-importing the same file inserts nothing new. The key covers the timestamp,
// the application and the duration; two records that agree on all three are
// treated as the same event, whatever their window title says.
//
// The id this adapter produces is the identity of the RECORD. The sync engine
// scopes it to the connection that imports it (see ../ids.js), because
// `public.observations.id` is a global primary key: an id derived from the
// record alone would collide between two accounts that import the same file,
// and the second account's import would be silently swallowed.
//
// The removal guarantee depends on the Phase 5 schema: imported observations
// carry `public.observations.integration_id`, and deleting the integration row
// cascades to those observations.

import { deterministicUuid } from "../ids.js";

/** The adapter's stable id. Used in ids, in the database and in the UI. */
export const ADAPTER_ID = "local_activity_file";

/**
 * The value stored in `public.observations.source`.
 *
 * The Phase 4 CHECK constraint allows 'manual' | 'collector' | 'import'; an
 * imported observation is 'import'.
 */
export const OBSERVATION_SOURCE = "import";

/**
 * Parses the chosen file into normalised records.
 *
 * @param {string} text the file content
 * @returns {{records: Array<{occurredAt: string, durationSeconds: number|null, application: string|null, windowTitle: string|null, isIdle: boolean}>}}
 * @throws {Error} with a user-readable message when the file is malformed
 */
export function parse(text) {
  if (typeof text !== "string") {
    throw new Error("The activity file must be read as text before it can be parsed.");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`The activity file is not valid JSON: ${error.message}`);
  }

  const rawRecords = extractRecords(data);
  return { records: rawRecords.map(normalizeRecord) };
}

/**
 * Maps normalised records to the observations the app ingests.
 *
 * The id is derived from the record, so the SAME record always produces the SAME
 * id: re-importing the same file is a no-op instead of a duplicate. The sync
 * engine scopes that id to the connection, so no other account's import can
 * collide with it.
 *
 * @param {Array<object>} records records as returned by `parse` (the snake_case
 *   spelling is accepted too, so raw file records can be passed straight in)
 * @returns {Array<{id: string, occurredAt: string, durationSeconds: number|null, application: string|null, windowTitle: string|null, isIdle: boolean, source: string}>}
 */
export function toObservations(records = []) {
  return records.map((record) => {
    const occurredAt = record?.occurredAt ?? record?.occurred_at ?? null;
    const application = record?.application ?? null;
    const durationSeconds = record?.durationSeconds ?? record?.duration_seconds ?? null;
    const windowTitle = record?.windowTitle ?? record?.window_title ?? null;
    const isIdle = record?.isIdle ?? record?.is_idle ?? false;

    const id = deterministicUuid(
      `${ADAPTER_ID}|${occurredAt}|${application ?? ""}|${durationSeconds ?? ""}`
    );

    return {
      id,
      occurredAt,
      durationSeconds,
      application,
      windowTitle,
      isIdle: isIdle === true,
      source: OBSERVATION_SOURCE,
    };
  });
}

/**
 * Pulls the record array out of either accepted file shape.
 *
 * @param {unknown} data the parsed JSON
 * @returns {Array<unknown>}
 * @throws {Error} when the JSON is neither an object with a `records` array nor an array
 */
function extractRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object" && Array.isArray(data.records)) {
    return data.records;
  }
  throw new Error(
    'The activity file must be a JSON object with a "records" array, or a JSON array of records.'
  );
}

/**
 * Normalises one record, rejecting the whole file when the record is malformed.
 *
 * @param {unknown} record
 * @param {number} index the record's position in the file
 * @returns {{occurredAt: string, durationSeconds: number|null, application: string|null, windowTitle: string|null, isIdle: boolean}}
 * @throws {Error} with a message that names the offending record
 */
function normalizeRecord(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Record ${index} is not an object.`);
  }

  return {
    occurredAt: readOccurredAt(record.occurred_at, index),
    durationSeconds: readDuration(record.duration_seconds, index),
    application: readText(record.application, index, "application"),
    windowTitle: readText(record.window_title, index, "window_title"),
    isIdle: readIdle(record.idle, index),
  };
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {string} the timestamp normalised to UTC ISO-8601
 * @throws {Error} when the timestamp is missing or unparseable
 */
function readOccurredAt(value, index) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Record ${index} has no valid "occurred_at" timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Record ${index} has no valid "occurred_at" timestamp.`);
  }
  return new Date(parsed).toISOString();
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {number|null} the duration in whole seconds, or null when not recorded
 * @throws {Error} when the duration is not a non-negative number
 */
function readDuration(value, index) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Record ${index} has an invalid "duration_seconds" value: expected a number of seconds.`
    );
  }
  if (value < 0) {
    throw new Error(
      `Record ${index} has a negative "duration_seconds" value (${value}). Durations cannot be negative.`
    );
  }
  return Math.round(value);
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {string} field
 * @returns {string|null}
 * @throws {Error} when the field is present but is not a string
 */
function readText(value, index, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(
      `Record ${index} has an invalid "${field}" value: expected a string.`
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {boolean}
 * @throws {Error} when the field is present but is not a boolean
 */
function readIdle(value, index) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new Error(
      `Record ${index} has an invalid "idle" value: expected true or false.`
    );
  }
  return value;
}

/**
 * The adapter itself.
 *
 * @type {import("../contract.js").IntegrationAdapter}
 */
export const localActivityFileAdapter = {
  id: ADAPTER_ID,
  label: "Local activity file",
  summary:
    "Imports activity records from a JSON file you choose on this device — no network, no third party, no credentials.",
  implemented: true,
  removalPolicy:
    "Disconnecting the integration deletes the observations it imported, and the time they contributed.",
  documentation: {
    canAccess:
      "Only the activity records inside the file the user explicitly picks. The adapter cannot see any other file, application, window, screen, account or device.",
    permissions:
      "None. The adapter needs no operating-system permission, no API key, no OAuth scope and no third-party account — the user grants nothing beyond choosing a file.",
    authentication:
      "None. There is no credential to store, refresh or revoke, so this integration can never fail because a token expired.",
    reads:
      "Reads the chosen file from the device as text, in the browser. It performs no network request and contacts no third party.",
    writes:
      "Writes nothing outside the app: the parsed records become observations in the user's own account.",
    synchronisation:
      "There is no background synchronisation. The import runs when the user picks a file and is finished when it returns — no polling, no schedule, no partial background state.",
    deduplication:
      "Every record gets a deterministic client-generated id derived from the record itself and the connection that imports it, so importing the same file again inserts nothing new, and no other account's import can collide with it.",
    errors:
      "A malformed file fails the whole run with a message naming the offending record, and nothing is imported; previously imported data stays untouched. There is no retry loop, because a local file cannot become valid by waiting.",
    retention:
      "The imported observations are kept until the user disconnects the integration or deletes the observations themselves.",
    removalOnDisconnect:
      "Disconnecting removes the observations this adapter imported — they are linked through public.observations.integration_id (ON DELETE CASCADE) — so the time they contributed disappears with them.",
  },
  parse,
  toObservations,
};
