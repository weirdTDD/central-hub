// Central Hub — adapter: Cursor and VS Code coding time.
//
// The extension (extensions/coding-tracker) sends heartbeats itself. This
// adapter is the contract the app shows, and the parser for the same heartbeat
// shape, so a batch can be checked without the editor running.
//
// A heartbeat is active time: editor, project name, language, file name, start,
// duration. It is not a path, a window title, or a keystroke.

import {
  ACTIVITY_KIND,
  CODING_PROVIDER,
  EDITORS,
  fileLabel,
  languageLabel,
  projectLabel,
} from "../../../../extensions/coding-tracker/lib/codingTime.js";
import { deterministicUuid } from "../ids.js";

export const ADAPTER_ID = CODING_PROVIDER;

/**
 * @param {string} text heartbeat batch JSON
 * @returns {{records: Array<object>}}
 */
export function parse(text) {
  if (typeof text !== "string") {
    throw new Error("Coding heartbeats must be read as text before they can be parsed.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Coding heartbeats are not valid JSON: ${error.message}`);
  }
  const records = Array.isArray(data?.heartbeats) ? data.heartbeats : null;
  if (!records) {
    throw new Error('Coding heartbeats must be a JSON object with a "heartbeats" array.');
  }
  return {
    records: records.map((record, index) => readHeartbeat(record, index)),
  };
}

/**
 * @param {Array<object>} records
 */
export function toObservations(records = []) {
  return records.map((record) => ({
    id: deterministicUuid(
      `${ADAPTER_ID}|${record.editor}|${record.projectName ?? ""}|${record.fileName ?? ""}|${record.language ?? ""}|${record.occurredAt}|${record.durationSeconds}`
    ),
    occurredAt: record.occurredAt,
    durationSeconds: record.durationSeconds,
    application: record.editor === "cursor" ? "Cursor" : "Visual Studio Code",
    windowTitle: null,
    isIdle: false,
    source: "collector",
    activityKind: ACTIVITY_KIND,
    editor: record.editor,
    projectName: record.projectName,
    language: record.language,
    fileName: record.fileName,
  }));
}

export const codingTrackerAdapter = {
  id: ADAPTER_ID,
  label: "Coding tracker",
  summary:
    "Records active coding time from the Central Hub extension in Cursor and VS Code.",
  implemented: true,
  collection: "extension",
  removalPolicy:
    "Disconnecting deletes the heartbeats this extension sent. Nothing is deleted inside Cursor or VS Code.",
  documentation: {
    canAccess:
      "Active coding time: which editor (Cursor or VS Code), the workspace folder's name, the file's name, and the language. File contents, full paths, window titles, and keystrokes are not read.",
    permissions:
      "You install the extension and sign in with your Central Hub account. Tracking can be paused from the command palette. The editor shows a Central Hub status item while it is running.",
    authentication:
      "The extension signs in with your email and password once. The password is not stored. A refresh token is kept in the editor's secret storage. The anon key is the public project key, never the service role key.",
    reads:
      "Reads editor activity (edits, selection changes, and the active file) to decide when you are active. Idle time and time while the window is unfocused are not counted.",
    writes:
      "Writes coding heartbeats as observations on your account, and updates this connection's status. It does not write to your files.",
    synchronisation:
      "Heartbeats are sent about once a minute while you are signed in, and after you come back online. Each heartbeat covers up to two minutes of active time.",
    deduplication:
      "Each heartbeat id is derived from the connection, the editor, the project, the file, the start time, and the duration. Sending the same heartbeat again does not create a second row.",
    errors:
      "If the network or the database rejects a batch, the heartbeats stay queued on this computer and are retried with backoff. The connection status becomes error and the message is stored on the connection.",
    retention:
      "Heartbeats stay until you delete that day's coding activity or disconnect this connector.",
    removalOnDisconnect:
      "Disconnecting deletes the connection and the heartbeats linked to it. Heartbeats still queued inside the editor are not on the server; sign out in the editor to stop sending them.",
  },
  parse,
  toObservations,
};

function readHeartbeat(record, index) {
  if (!record || typeof record !== "object") {
    throw new Error(`Heartbeat ${index} is not an object.`);
  }
  const occurredAt = record.occurredAt ?? record.occurred_at;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error(`Heartbeat ${index} has no valid occurrence time.`);
  }
  const duration = Number(record.durationSeconds ?? record.duration_seconds);
  if (!Number.isInteger(duration) || duration < 1) {
    throw new Error(`Heartbeat ${index} needs a positive whole-second duration.`);
  }
  const editor = record.editor;
  if (!EDITORS.includes(editor)) {
    throw new Error(`Heartbeat ${index} must name the editor as cursor or vscode.`);
  }
  const fileName = nullableLabel(record.fileName ?? record.file_name, fileLabel, index, "file");
  const projectName = nullableLabel(
    record.projectName ?? record.project_name,
    projectLabel,
    index,
    "project"
  );
  const language = nullableLabel(record.language, languageLabel, index, "language");
  return {
    occurredAt: new Date(occurredAt).toISOString(),
    durationSeconds: duration,
    editor,
    projectName,
    fileName,
    language,
  };
}

function nullableLabel(value, normalize, index, label) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.includes("/") || text.includes("\\") || text.includes("..")) {
    throw new Error(`Heartbeat ${index} must use a ${label} name, not a path.`);
  }
  return normalize(text);
}
