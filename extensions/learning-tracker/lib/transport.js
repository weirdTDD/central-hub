// HTTP requests the learning extension sends to Supabase.
//
// These functions only BUILD the request. The extension performs it. Building
// them here keeps the auth header, the idempotent write, and the "no URL"
// rule testable without a network.

import { ACTIVITY_KIND, scopeHeartbeatId } from "./learningTime.js";
import {
  LEARNING_PROVIDER,
  isHostname,
  normalizeSiteList,
  sanitizeLabel,
  sanitizeTitle,
  sanitizeTrackLabel,
} from "./sites.js";

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
    Accept: "application/json",
  };
}

/**
 * Email + password sign-in. The password is in this body and nowhere else.
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
 * Reads the learning connection, including the allowlist in config.
 *
 * @param {object} input
 * @returns {{url: string, method: string, headers: object}}
 */
export function buildGetIntegrationRequest({ url, anonKey, accessToken }) {
  return {
    method: "GET",
    url: `${trimUrl(url)}/rest/v1/integrations?provider=eq.${LEARNING_PROVIDER}&select=id,provider,status,config,last_sync_at,last_error`,
    headers: authHeaders(anonKey, accessToken),
  };
}

/**
 * Opens or updates the learning-tracker connection.
 *
 * `config.sites` is the allowlist. It is not a credential. `last_sync_at` is
 * included only when a flush actually stored heartbeats, so a status update
 * does not erase the previous success.
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
  const payload = {
    provider: LEARNING_PROVIDER,
    label: "Learning tracker",
    status,
    config: {
      sites: normalizeSiteList(config?.sites),
      paused: config?.paused === true,
      browser: config?.browser ?? null,
      heartbeatSeconds: config?.heartbeatSeconds ?? null,
      idleSeconds: config?.idleSeconds ?? null,
    },
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
 * Inserts heartbeats as observations. Duplicate ids are ignored.
 *
 * @param {object} input
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
    throw new Error("A learning heartbeat needs the connection id before it can be stored.");
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
 * One observation row. A URL on the heartbeat is rejected.
 *
 * @param {object} heartbeat
 * @param {string} connectionId
 * @returns {object}
 */
export function toObservationRow(heartbeat, connectionId) {
  if (!heartbeat || typeof heartbeat !== "object") {
    throw new Error("A learning heartbeat must be an object.");
  }
  if (heartbeat.url || heartbeat.href || heartbeat.pageUrl || heartbeat.page_url) {
    throw new Error("A learning heartbeat must not include a URL.");
  }
  const siteHost = heartbeat.siteHost ?? heartbeat.site_host;
  if (!isHostname(siteHost)) {
    throw new Error("A learning heartbeat needs a host name, not a URL or a path.");
  }
  const duration = Number(heartbeat.durationSeconds ?? heartbeat.duration_seconds);
  if (!Number.isInteger(duration) || duration < 1) {
    throw new Error("A learning heartbeat needs a positive whole-second duration.");
  }
  const occurredAt = heartbeat.occurredAt ?? heartbeat.occurred_at;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("A learning heartbeat needs an occurrence time.");
  }
  const siteLabel = sanitizeLabel(heartbeat.siteLabel ?? heartbeat.site_label ?? heartbeat.application) || siteHost;
  const pageTitle = nullableTrack(heartbeat.pageTitle ?? heartbeat.page_title, sanitizeTitle, "page title");
  const courseLabel = nullableTrack(heartbeat.courseLabel ?? heartbeat.course_label, sanitizeTrackLabel, "course");
  const lessonLabel = nullableTrack(heartbeat.lessonLabel ?? heartbeat.lesson_label, sanitizeTrackLabel, "lesson");
  const row = {
    occurredAt,
    durationSeconds: duration,
    siteHost,
    siteLabel,
    courseLabel,
    lessonLabel,
    pageTitle,
  };
  return {
    id: scopeHeartbeatId(connectionId, row),
    source: "collector",
    occurred_at: occurredAt,
    duration_seconds: duration,
    application: siteLabel,
    window_title: null,
    is_idle: false,
    integration_id: connectionId,
    activity_kind: ACTIVITY_KIND,
    site_host: siteHost,
    page_title: pageTitle,
    course_label: courseLabel,
    lesson_label: lessonLabel,
  };
}

function nullableTrack(value, normalize, label) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.includes("://") || text.includes("\\")) {
    throw new Error(`The ${label} on a learning heartbeat must not be a URL or a path.`);
  }
  const cleaned = normalize(text);
  if (cleaned == null) {
    throw new Error(`The ${label} on a learning heartbeat could not be stored.`);
  }
  return cleaned;
}

function trimUrl(url) {
  return String(url ?? "").replace(/\/+$/, "");
}
