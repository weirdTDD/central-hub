// HTTP requests the coding extension sends to Supabase.
//
// These functions only BUILD the request. The extension performs it. Building
// them here keeps the auth header, the idempotent write and the "no file paths"
// rule testable without a network.

import {
  ACTIVITY_KIND,
  CODING_PROVIDER,
  applicationName,
  fileLabel,
  languageLabel,
  projectLabel,
  scopeHeartbeatId,
} from "./codingTime.js";

/**
 * @param {string} anonKey
 * @param {string} accessToken
 * @returns {Record<string, string>}
 */
export function authHeaders(anonKey, accessToken) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Email + password sign-in. The password is in this body and nowhere else:
 * the caller must not store the request.
 *
 * @param {object} input
 * @returns {{url: string, method: string, headers: object, body: string}}
 */
export function buildSignInRequest({ url, anonKey, email, password }) {
  return {
    method: "POST",
    url: `${trimUrl(url)}/auth/v1/token?grant_type=password`,
    headers: authHeaders(anonKey, anonKey),
    body: JSON.stringify({ email, password }),
  };
}

/**
 * @param {object} input
 * @returns {{url: string, method: string, headers: object, body: string}}
 */
export function buildRefreshRequest({ url, anonKey, refreshToken }) {
  return {
    method: "POST",
    url: `${trimUrl(url)}/auth/v1/token?grant_type=refresh_token`,
    headers: authHeaders(anonKey, anonKey),
    body: JSON.stringify({ refresh_token: refreshToken }),
  };
}

/**
 * Opens or updates the coding-tracker connection.
 *
 * `config` is non-sensitive (intervals and which editor). The access token is
 * a header, never a column.
 *
 * @param {object} input
 * @returns {{url: string, method: string, headers: object, body: string}}
 */
export function buildUpsertIntegrationRequest({
  url,
  anonKey,
  accessToken,
  status,
  config,
  lastError,
  lastSyncAt,
}) {
  // last_sync_at is included only when a flush actually stored heartbeats.
  // Sending null would erase the previous success. last_error is included only
  // when the caller passes it, so a syncing update does not clear an old error
  // and a success update can clear it by passing null.
  const payload = {
    provider: CODING_PROVIDER,
    label: "Coding tracker",
    status,
    config: config ?? {},
  };
  if (lastError !== undefined) payload.last_error = lastError;
  if (typeof lastSyncAt === "string" && lastSyncAt) payload.last_sync_at = lastSyncAt;
  return {
    method: "POST",
    url: `${trimUrl(url)}/rest/v1/integrations?on_conflict=user_id,provider`,
    headers: {
      ...authHeaders(anonKey, accessToken),
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  };
}

/**
 * Inserts heartbeats as observations.
 *
 * Duplicate ids are ignored, so a retried flush does not create a second row
 * and does not change the row already stored.
 *
 * @param {object} input
 * @param {string} input.connectionId the integration row id
 * @param {Array<object>} input.heartbeats
 * @returns {{url: string, method: string, headers: object, body: string}}
 */
export function buildInsertHeartbeatsRequest({
  url,
  anonKey,
  accessToken,
  connectionId,
  heartbeats,
}) {
  if (!connectionId) {
    throw new Error("A coding heartbeat needs the connection id before it can be stored.");
  }
  const rows = (heartbeats ?? []).map((heartbeat) => toObservationRow(heartbeat, connectionId));
  return {
    method: "POST",
    url: `${trimUrl(url)}/rest/v1/observations?on_conflict=id`,
    headers: {
      ...authHeaders(anonKey, accessToken),
      Prefer: "resolution=ignore-duplicates,return=representation",
    },
    body: JSON.stringify(rows),
  };
}

/**
 * One observation row. A path in the file or project name is rejected.
 *
 * @param {object} heartbeat
 * @param {string} connectionId
 * @returns {object}
 */
export function toObservationRow(heartbeat, connectionId) {
  const fileName = fileLabel(heartbeat?.fileName ?? heartbeat?.file_name);
  const projectName = projectLabel(heartbeat?.projectName ?? heartbeat?.project_name);
  assertBasename(heartbeat?.fileName ?? heartbeat?.file_name, fileName, "file");
  assertBasename(heartbeat?.projectName ?? heartbeat?.project_name, projectName, "project");
  const editor = heartbeat?.editor === "cursor" ? "cursor" : heartbeat?.editor === "vscode" ? "vscode" : null;
  if (!editor) {
    throw new Error("A coding heartbeat must name the editor as cursor or vscode.");
  }
  const duration = Number(heartbeat?.durationSeconds ?? heartbeat?.duration_seconds);
  if (!Number.isInteger(duration) || duration < 1) {
    throw new Error("A coding heartbeat needs a positive whole-second duration.");
  }
  const occurredAt = heartbeat?.occurredAt ?? heartbeat?.occurred_at;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("A coding heartbeat needs an occurrence time.");
  }
  const language = languageLabel(heartbeat?.language);
  const row = {
    occurredAt,
    durationSeconds: duration,
    editor,
    projectName,
    fileName,
    language,
  };
  return {
    id: scopeHeartbeatId(connectionId, row),
    source: "collector",
    occurred_at: occurredAt,
    duration_seconds: duration,
    application: applicationName(editor),
    window_title: null,
    is_idle: false,
    integration_id: connectionId,
    activity_kind: ACTIVITY_KIND,
    editor,
    project_name: projectName,
    language,
    file_name: fileName,
  };
}

function assertBasename(raw, sanitized, label) {
  if (raw == null || raw === "") return;
  if (sanitized == null) {
    throw new Error(`The ${label} name on a coding heartbeat must be a name, not a path.`);
  }
  const text = String(raw);
  if (text.includes("/") || text.includes("\\") || text.includes("..")) {
    throw new Error(`The ${label} name on a coding heartbeat must be a name, not a path.`);
  }
}

function trimUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}
