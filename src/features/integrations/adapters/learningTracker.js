// Sentral Hub — adapter: browser learning time.
//
// The extension (extensions/learning-tracker) sends heartbeats itself. This
// adapter is the contract the app shows, and the parser for the same heartbeat
// shape, so a batch can be checked without the browser running.
//
// A heartbeat is active time on an allowlisted site: host, optional course and
// lesson, optional page title, start, and duration. It is not a URL.

import {
  ACTIVITY_KIND,
  LEARNING_PROVIDER,
  isHostname,
  sanitizeLabel,
  sanitizeTitle,
  sanitizeTrackLabel,
} from "../../../../extensions/learning-tracker/lib/sites.js";
import { deterministicUuid } from "../ids.js";

export const ADAPTER_ID = LEARNING_PROVIDER;

/**
 * @param {string} text heartbeat batch JSON
 * @returns {{records: Array<object>}}
 */
export function parse(text) {
  if (typeof text !== "string") {
    throw new Error("Learning heartbeats must be read as text before they can be parsed.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Learning heartbeats are not valid JSON: ${error.message}`);
  }
  const records = Array.isArray(data?.heartbeats) ? data.heartbeats : null;
  if (!records) {
    throw new Error('Learning heartbeats must be a JSON object with a "heartbeats" array.');
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
      `${ADAPTER_ID}|${record.siteHost}|${record.courseLabel ?? ""}|${record.lessonLabel ?? ""}|${record.pageTitle ?? ""}|${record.occurredAt}|${record.durationSeconds}`
    ),
    occurredAt: record.occurredAt,
    durationSeconds: record.durationSeconds,
    application: record.siteLabel,
    windowTitle: null,
    isIdle: false,
    source: "collector",
    activityKind: ACTIVITY_KIND,
    siteHost: record.siteHost,
    pageTitle: record.pageTitle,
    courseLabel: record.courseLabel,
    lessonLabel: record.lessonLabel,
  }));
}

export const learningTrackerAdapter = {
  id: ADAPTER_ID,
  label: "Learning tracker",
  summary: "Records active time on the learning sites you choose, from the Sentral Hub browser extension.",
  implemented: true,
  collection: "extension",
  timelinePath: "/learning",
  timelineLabel: "Learning",
  removalPolicy:
    "Disconnecting deletes the heartbeats this extension sent. Nothing is deleted in the browser.",
  documentation: {
    canAccess:
      "Active time on sites you add to the allowlist: the site, and when it can be read from the page, the course, the lesson, and the page title. The address, the query string, and every site that is not on the list are not stored. File contents and keystrokes are not read.",
    permissions:
      "You load the extension in Chrome, Edge, or Firefox and sign in with your Sentral Hub account. It can see the active tab's address so it can decide whether that tab is on the allowlist. It does not ask for access to every site, and it does not keep addresses that miss the list.",
    authentication:
      "The extension signs in with your email and password once. The password is not stored. A refresh token is kept in the extension's storage. The anon key is the public project key, never the service role key.",
    reads:
      "Reads the focused tab and the browser idle state. Time counts only while that tab matches a site you added, the window is focused, and you are active.",
    writes:
      "Writes learning heartbeats as observations on your account, and updates this connection's status and allowlist. It does not write to the pages you visit.",
    synchronisation:
      "Heartbeats are sent about once a minute while you are signed in, and after you come back online. Each heartbeat covers up to one minute of active time. The allowlist is the list saved on this connection.",
    deduplication:
      "Each heartbeat id is derived from the connection, the site, the course, the lesson, the page title, the start time, and the duration. Sending the same heartbeat again does not create a second row.",
    errors:
      "If the network or the database rejects a batch, the heartbeats stay queued in the extension and are retried. The connection status becomes error and the message is stored on the connection.",
    retention:
      "Heartbeats stay until you delete that day's learning activity or disconnect this connector. The allowlist stays on the connection until you change it or disconnect.",
    removalOnDisconnect:
      "Disconnecting deletes the connection and the heartbeats linked to it. Heartbeats still queued in the browser are not on the server; sign out in the extension to stop sending them.",
  },
  parse,
  toObservations,
};

function readHeartbeat(record, index) {
  if (!record || typeof record !== "object") {
    throw new Error(`Heartbeat ${index} is not an object.`);
  }
  if (record.url || record.href || record.pageUrl) {
    throw new Error(`Heartbeat ${index} must not include a URL.`);
  }
  const occurredAt = record.occurredAt ?? record.occurred_at;
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error(`Heartbeat ${index} has no valid occurrence time.`);
  }
  const duration = Number(record.durationSeconds ?? record.duration_seconds);
  if (!Number.isInteger(duration) || duration < 1) {
    throw new Error(`Heartbeat ${index} needs a positive whole-second duration.`);
  }
  const siteHost = record.siteHost ?? record.site_host;
  if (!isHostname(siteHost)) {
    throw new Error(`Heartbeat ${index} needs a host name, not a URL or a path.`);
  }
  return {
    occurredAt: new Date(occurredAt).toISOString(),
    durationSeconds: duration,
    siteHost,
    siteLabel: sanitizeLabel(record.siteLabel ?? record.site_label) || siteHost,
    courseLabel: optionalLabel(record.courseLabel ?? record.course_label, sanitizeTrackLabel, index, "course"),
    lessonLabel: optionalLabel(record.lessonLabel ?? record.lesson_label, sanitizeTrackLabel, index, "lesson"),
    pageTitle: optionalLabel(record.pageTitle ?? record.page_title, sanitizeTitle, index, "page title"),
  };
}

function optionalLabel(value, normalize, index, label) {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.includes("://") || text.includes("\\")) {
    throw new Error(`Heartbeat ${index} must not use a URL as the ${label}.`);
  }
  const cleaned = normalize(text);
  if (!cleaned) throw new Error(`Heartbeat ${index} has a ${label} that cannot be stored.`);
  return cleaned;
}
