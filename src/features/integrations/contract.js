// Central Hub — the integration contract: adapter registry, statuses, and the
// documentation every adapter must carry.
//
// Serves MASTER_SPEC Section 7D: integrations are independent adapters with
// DOCUMENTED contracts, and the app must show truthful states — disconnected,
// connecting, connected, syncing, error — together with the last successful sync.
//
// The adapter documentation is DATA, not prose kept in a wiki: the UI renders the
// very strings the adapter declares, so what the user reads cannot drift away
// from what the adapter actually does.
//
// This module is deliberately PURE (no React, no network, no browser APIs) so the
// rules can be verified with plain Node assertions — see scripts/verify-integrations.mjs.

import { localActivityFileAdapter } from "./adapters/localActivityFile.js";

/**
 * The states an integration can be in. The UI shows these verbatim, so they are
 * the product's vocabulary and not an implementation detail.
 */
export const INTEGRATION_STATUSES = [
  "disconnected",
  "connecting",
  "connected",
  "syncing",
  "error",
];

/**
 * The states a single synchronisation run can end in. A run is its own record,
 * so a failed run does not erase the fact that an earlier run succeeded.
 */
export const SYNC_RUN_STATUSES = ["running", "success", "error"];

/**
 * The legal moves between integration states.
 *
 * The flow a connection follows is
 *
 *     disconnected -> connecting -> syncing -> connected
 *
 * and a step that fails goes to "error" instead of moving on. "connected" is
 * reached only when the import is over, so the UI is never told "connected"
 * while data is still on its way in. A connection that is already open goes
 * straight from "connected" to "syncing" when it imports again — a repeat
 * import reuses the open connection, it does not reconnect it, so no
 * "connected" -> "connecting" edge is needed.
 *
 * A move that is not listed here is refused, so the UI can never show a state
 * the machine cannot reach (for example "syncing" without a connection, or
 * "connected" straight after a failure).
 */
export const STATUS_TRANSITIONS = {
  disconnected: ["connecting"],
  connecting: ["syncing", "connected", "error", "disconnected"],
  syncing: ["connected", "error"],
  connected: ["syncing", "disconnected"],
  error: ["connecting", "disconnected"],
};

/**
 * The documentation fields every adapter must fill in — one non-empty string each.
 *
 * Shared as a single list so the UI and the verification script check the same
 * contract instead of each keeping their own copy of it.
 */
export const DOCUMENTATION_FIELDS = [
  "canAccess",
  "permissions",
  "authentication",
  "reads",
  "writes",
  "synchronisation",
  "deduplication",
  "errors",
  "retention",
  "removalOnDisconnect",
];

/**
 * @typedef {object} IntegrationDocumentation
 * @property {string} canAccess what information the adapter can access
 * @property {string} permissions required permissions and configuration (least privilege)
 * @property {string} authentication how authentication works
 * @property {string} reads what data it reads
 * @property {string} writes what data it writes
 * @property {string} synchronisation how synchronisation works
 * @property {string} deduplication how duplicate data is prevented
 * @property {string} errors how errors, retries and expired credentials are handled
 * @property {string} retention what data is retained
 * @property {string} removalOnDisconnect how the data is removed, including on disconnect
 */

/**
 * @typedef {object} IntegrationObservation
 * @property {string} id client-generated idempotency key (a `uuid`): the
 *   identity of the record, scoped to the connection that imports it
 * @property {string} occurredAt ISO-8601 occurrence time (UTC)
 * @property {number|null} durationSeconds recorded duration in seconds; null means
 *   "not recorded" — never 0
 * @property {string|null} application the application name, or null
 * @property {string|null} windowTitle the window title, or null
 * @property {boolean} isIdle whether the record was idle
 * @property {string} source one of 'manual' | 'collector' | 'import'
 */

/**
 * @typedef {object} IntegrationAdapter
 * @property {string} id stable identifier of the adapter
 * @property {string} label human-readable name
 * @property {string} summary one sentence describing what the adapter does
 * @property {boolean} implemented whether the adapter is actually working
 * @property {string} removalPolicy one sentence: what happens to its data on disconnect
 * @property {IntegrationDocumentation} documentation the ten documented contract fields
 * @property {(text: string) => {records: Array<object>}} parse turns the source
 *   payload into normalised records; throws an Error with a clear message on
 *   malformed input
 * @property {(records: Array<object>) => Array<IntegrationObservation>} toObservations
 *   maps records to the observations the app ingests
 */

/** The registered adapters. Adding an adapter means adding it here. */
const ADAPTERS = [localActivityFileAdapter];

/**
 * Every registered adapter.
 *
 * A copy is returned so a caller cannot mutate the registry.
 *
 * @returns {IntegrationAdapter[]}
 */
export function listAdapters() {
  return [...ADAPTERS];
}

/**
 * One adapter by its id.
 *
 * @param {string} id
 * @returns {IntegrationAdapter|undefined} the adapter, or undefined when the id is unknown
 */
export function getAdapter(id) {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/**
 * True when a move between two integration states is permitted.
 *
 * An unknown status on either side is never legal — the state machine only
 * describes the five documented states.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isLegalStatusTransition(from, to) {
  const allowed = STATUS_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Asserts that a move between two integration states is permitted.
 *
 * @param {string} from
 * @param {string} to
 * @throws {Error} when the transition is not legal
 */
export function assertLegalStatusTransition(from, to) {
  if (isLegalStatusTransition(from, to)) return;
  const allowed = STATUS_TRANSITIONS[from];
  const detail = allowed
    ? `Allowed from "${from}": ${allowed.join(", ")}.`
    : `"${from}" is not a known integration status.`;
  throw new Error(
    `Illegal integration status transition: "${from}" -> "${to}". ${detail}`
  );
}
