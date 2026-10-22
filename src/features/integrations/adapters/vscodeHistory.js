// Central Hub — adapter: VS Code local history.
//
// Reads the edit history VS Code already keeps on this computer (User/History).
// The collector on the dev server reads those files. This module only parses the
// minimised payload the collector hands over: a file name and the time of the
// edit. Full paths never enter the payload, so a username or a folder is not
// stored.
//
// An edit has a time and no measured duration. The duration stays null.

import { deterministicUuid } from "../ids.js";

export const ADAPTER_ID = "vscode";
export const OBSERVATION_SOURCE = "import";
const APPLICATION = "Visual Studio Code";

/**
 * @param {string} text collector payload
 * @returns {{records: Array<{occurredAt: string, fileName: string}>}}
 */
export function parse(text) {
  const data = readPayload(text);
  return {
    records: data.records.map((record, index) => ({
      occurredAt: readTimestamp(record?.occurred_at, index),
      fileName: readFileName(record?.file_name, index),
    })),
  };
}

/**
 * @param {Array<{occurredAt: string, fileName: string}>} records
 */
export function toObservations(records = []) {
  return records.map((record) => ({
    id: deterministicUuid(
      `${ADAPTER_ID}|${record.occurredAt}|${record.fileName}|`
    ),
    occurredAt: record.occurredAt,
    durationSeconds: null,
    application: APPLICATION,
    windowTitle: record.fileName,
    isIdle: false,
    source: OBSERVATION_SOURCE,
  }));
}

export const vscodeHistoryAdapter = {
  id: ADAPTER_ID,
  label: "VS Code",
  summary:
    "Imports edit times from the local history VS Code already stores on this computer.",
  implemented: true,
  collection: "local",
  removalPolicy:
    "Disconnecting deletes the observations this sync imported. VS Code's own history files are left untouched.",
  documentation: {
    canAccess:
      "The file name and the time of edits in VS Code's local history on this computer. Full paths, file contents, and other applications are not read.",
    permissions:
      "The collector runs beside the app on this computer and reads only VS Code's History folder. It starts when you press Sync.",
    authentication:
      "None. There is no VS Code account and no token. The read uses the files already on this computer.",
    reads:
      "Reads entries.json under VS Code's User/History folder. Each entry contributes its timestamp and the file's name.",
    writes:
      "Writes observations in your account. It does not write back to VS Code.",
    synchronisation:
      "Runs when you press Sync. The latest 400 edits are sent. Pressing Sync again inserts nothing new for edits already imported.",
    deduplication:
      "Each observation id is derived from the edit time and the file name, then scoped to this connection, so the same edit is not stored twice.",
    errors:
      "If the history folder is missing or a record is malformed, the sync fails with the reason and previously imported edits stay as they were.",
    retention:
      "Imported observations stay until you disconnect this connector or delete them.",
    removalOnDisconnect:
      "Disconnecting deletes the observations linked to this connection. The History folder on disk is not deleted.",
  },
  parse,
  toObservations,
};

function readPayload(text) {
  if (typeof text !== "string") {
    throw new Error("VS Code history must be read as text before it can be parsed.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`VS Code history is not valid JSON: ${error.message}`);
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.records)) {
    throw new Error('VS Code history must be a JSON object with a "records" array.');
  }
  return data;
}

function readTimestamp(value, index) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`Record ${index} has no valid "occurred_at" timestamp.`);
  }
  return new Date(value).toISOString();
}

function readFileName(value, index) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Record ${index} has no file name.`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`Record ${index} must be a file name, not a path.`);
  }
  return value;
}
