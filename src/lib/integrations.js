// Sentral Hub — the integrations data layer.
//
// Phase 5 (MASTER_SPEC Section 7D) persistence: one connection row per user and
// provider, one row per synchronisation attempt, and the provenance link that
// lets a disconnect remove exactly the observations an integration imported.
//
// The rules of this layer (the same ones src/lib/tracking.js follows):
//   - EXPLICIT column lists, never select("*"): the shape of a row is decided
//     here, not by the column order of the database.
//   - BOUNDED reads with an exact count that return {rows, total, truncated}, so
//     the UI can say "showing 200 of 512" instead of silently showing a
//     truncated list.
//   - `if (error) throw error;` — this layer reports a failure, it never hides
//     one and never invents a value in place of a missing one.
//   - CLIENT-SIDE validation before every write, so an invalid value fails here
//     with a readable message instead of as an opaque database error.
//
// The `config` column holds NON-SENSITIVE adapter settings only (file paths,
// filters, poll intervals, limits). CREDENTIALS MUST NEVER BE WRITTEN THERE:
// the column is readable by every signed-in user through the client, so a
// secret written here is a secret leaked. A credential belongs in a
// server-side secret store, which does not exist yet.

import { supabase } from "./supabase";
import {
  INTEGRATION_STATUSES,
  SYNC_RUN_STATUSES,
} from "../features/integrations/contract.js";

const INTEGRATIONS_TABLE = "integrations";
const SYNC_RUNS_TABLE = "integration_sync_runs";

const INTEGRATION_COLUMNS =
  "id, user_id, provider, label, status, config, last_sync_at, last_error, created_at, updated_at";
const SYNC_RUN_COLUMNS =
  "id, user_id, integration_id, status, started_at, finished_at, records_seen, records_written, records_skipped, error, created_at, updated_at";

/**
 * Maximum rows fetched in one page.
 *
 * PostgREST applies a server-side `max-rows` cap (1000 by default) and returns a
 * truncated list with no indication that anything was dropped, so the app fetches a
 * bounded page and reports the true total instead of silently showing incomplete data.
 *
 * A user holds few connections (one per provider), so the page is small on purpose:
 * the integrations list must stay complete, not merely long.
 */
export const INTEGRATIONS_PAGE_SIZE = 200;

/**
 * Lists the signed-in user's connections, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] page size (defaults to INTEGRATIONS_PAGE_SIZE)
 * @returns {Promise<{rows: Array<object>, total: number|null, truncated: boolean}>}
 */
export async function listIntegrations({ limit = INTEGRATIONS_PAGE_SIZE } = {}) {
  const { data, error, count } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select(INTEGRATION_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const rows = data ?? [];
  return {
    rows,
    total: count ?? null,
    truncated: count !== null && count > rows.length,
  };
}

/**
 * Finds the user's connection to one provider.
 *
 * @param {string} provider the adapter id, e.g. 'local_activity_file'
 * @returns {Promise<object|null>} the row, or null when the provider is not connected
 */
export async function getIntegrationByProvider(provider) {
  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .select(INTEGRATION_COLUMNS)
    .eq("provider", provider)
    .maybeSingle();

  if (error) throw error;

  return data ?? null;
}

/**
 * Creates or updates the user's connection to a provider.
 *
 * The write is an upsert on the `(user_id, provider)` unique key, so connecting the
 * same provider twice updates the ONE existing connection instead of failing with a
 * duplicate key — there is exactly one connection per provider.
 *
 * The owner (`user_id`) is NOT sent: the database fills it with `auth.uid()` and the
 * row-level-security policy rejects any write that does not belong to the caller, so
 * a client cannot forge an owner.
 *
 * @param {object} values
 * @param {string} values.provider the adapter id
 * @param {string|null} [values.label] human-readable name of the connection
 * @param {string} [values.status] one of the five documented connection states
 * @param {object} [values.config] NON-SENSITIVE adapter settings — never a credential
 * @param {string|null} [values.lastError] the last failure message
 * @param {string|null} [values.lastSyncAt] ISO timestamp of the last SUCCESSFUL sync
 * @returns {Promise<object>} the stored row
 */
export async function upsertIntegration({
  provider,
  label = null,
  status = "disconnected",
  config = {},
  lastError = null,
  lastSyncAt = null,
}) {
  assertProvider(provider);
  assertIntegrationStatus(status);
  assertConfig(config);

  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .upsert(
      {
        provider,
        label: label ?? null,
        status,
        config,
        last_error: lastError ?? null,
        last_sync_at: lastSyncAt ?? null,
      },
      { onConflict: "user_id,provider" }
    )
    .select(INTEGRATION_COLUMNS)
    .single();

  if (error) throw error;

  return data;
}

/**
 * Writes a new state onto a connection.
 *
 * `lastError` is always written: an omitted error clears the stored one, because a
 * connection that is no longer failing must not keep an old message.
 *
 * `lastSyncAt` is written ONLY when the caller passes it. The column is the time of
 * the last SUCCESSFUL synchronisation — a fact, not a setting — so a caller that
 * merely changes the state must not erase it by accident.
 *
 * @param {string} id the connection row id
 * @param {object} values
 * @param {string} values.status one of the five documented connection states
 * @param {string|null} [values.lastError] the failure message to store (default null)
 * @param {string|null} [values.lastSyncAt] ISO timestamp of the last successful sync
 * @returns {Promise<object>} the updated row
 */
export async function updateIntegrationStatus(id, values = {}) {
  const { status, lastError = null, lastSyncAt = null } = values;
  assertId(id, "connection");
  assertIntegrationStatus(status);

  const payload = { status, last_error: lastError };
  if ("lastSyncAt" in values) payload.last_sync_at = lastSyncAt;

  const { data, error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(INTEGRATION_COLUMNS)
    .single();

  if (error) throw error;

  return data;
}

/**
 * Disconnects a provider: deletes the connection row.
 *
 * The deletion IS the disconnect operation. The database removes the row's
 * `integration_sync_runs` and the observations the connection imported
 * (ON DELETE CASCADE) — exactly the data that connection produced, and nothing
 * else. Observations that were not imported by it are untouched.
 *
 * @param {string} id the connection row id
 * @returns {Promise<void>}
 */
export async function deleteIntegration(id) {
  assertId(id, "connection");

  const { error } = await supabase
    .from(INTEGRATIONS_TABLE)
    .delete()
    .eq("id", id);

  if (error) throw error;
}

/**
 * Lists the synchronisation runs, most recently started first.
 *
 * A run is the audit trail of one attempt, so the counters say what the adapter
 * saw, what it wrote and what it deliberately skipped.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.integrationId] restrict to one connection
 * @param {number} [opts.limit] page size (defaults to INTEGRATIONS_PAGE_SIZE)
 * @returns {Promise<{rows: Array<object>, total: number|null, truncated: boolean}>}
 */
export async function listSyncRuns({
  integrationId = null,
  limit = INTEGRATIONS_PAGE_SIZE,
} = {}) {
  let query = supabase
    .from(SYNC_RUNS_TABLE)
    .select(SYNC_RUN_COLUMNS, { count: "exact" })
    .order("started_at", { ascending: false })
    .limit(limit);

  if (integrationId) query = query.eq("integration_id", integrationId);

  const { data, error, count } = await query;
  if (error) throw error;

  const rows = data ?? [];
  return {
    rows,
    total: count ?? null,
    truncated: count !== null && count > rows.length,
  };
}

/**
 * Opens a synchronisation run.
 *
 * The run is written as 'running' before the adapter is called, so a crash or a
 * timeout leaves a run that is still 'running' — the truth of an interrupted
 * attempt, not an estimate.
 *
 * @param {object} values
 * @param {string} values.integrationId the connection the run belongs to
 * @returns {Promise<object>} the created run row (status 'running')
 */
export async function startSyncRun({ integrationId }) {
  assertId(integrationId, "connection");

  const { data, error } = await supabase
    .from(SYNC_RUNS_TABLE)
    .insert({
      integration_id: integrationId,
      status: "running",
      started_at: new Date().toISOString(),
      records_seen: 0,
      records_written: 0,
      records_skipped: 0,
    })
    .select(SYNC_RUN_COLUMNS)
    .single();

  if (error) throw error;

  return data;
}

/**
 * Closes a synchronisation run with its outcome and its counters.
 *
 * @param {string} id the run row id
 * @param {object} values
 * @param {string} values.status 'success' or 'error'
 * @param {number} [values.recordsSeen] records the adapter read
 * @param {number} [values.recordsWritten] records written to the app
 * @param {number} [values.recordsSkipped] records deliberately not written
 * @param {string|null} [values.error] the failure message
 * @returns {Promise<object>} the updated run row
 */
export async function finishSyncRun(
  id,
  {
    status,
    recordsSeen = 0,
    recordsWritten = 0,
    recordsSkipped = 0,
    error = null,
  }
) {
  assertId(id, "sync run");
  assertSyncRunStatus(status);
  assertCounter(recordsSeen, "recordsSeen");
  assertCounter(recordsWritten, "recordsWritten");
  assertCounter(recordsSkipped, "recordsSkipped");

  const { data, error: dbError } = await supabase
    .from(SYNC_RUNS_TABLE)
    .update({
      status,
      finished_at: new Date().toISOString(),
      records_seen: recordsSeen,
      records_written: recordsWritten,
      records_skipped: recordsSkipped,
      error: error ?? null,
    })
    .eq("id", id)
    .select(SYNC_RUN_COLUMNS)
    .single();

  if (dbError) throw dbError;

  return data;
}

/**
 * @param {unknown} provider
 * @throws {Error} when the provider is not a non-empty string
 */
function assertProvider(provider) {
  if (typeof provider !== "string" || provider.trim() === "") {
    throw new Error("A connection needs a provider id.");
  }
}

/**
 * @param {unknown} id
 * @param {string} what the kind of row, used in the message
 * @throws {Error} when the id is not a non-empty string
 */
function assertId(id, what) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`A ${what} needs an id.`);
  }
}

/**
 * @param {unknown} status
 * @throws {Error} when the status is not one of the documented connection states
 */
function assertIntegrationStatus(status) {
  if (!INTEGRATION_STATUSES.includes(status)) {
    throw new Error(
      `"${status}" is not a connection state. Allowed: ${INTEGRATION_STATUSES.join(", ")}.`
    );
  }
}

/**
 * @param {unknown} status
 * @throws {Error} when the status is not one of the documented run states
 */
function assertSyncRunStatus(status) {
  if (!SYNC_RUN_STATUSES.includes(status)) {
    throw new Error(
      `"${status}" is not a synchronisation run state. Allowed: ${SYNC_RUN_STATUSES.join(", ")}.`
    );
  }
}

/**
 * @param {unknown} config
 * @throws {Error} when the settings are not a plain object
 */
function assertConfig(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("The connection settings must be an object.");
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @throws {Error} when the counter is not a non-negative whole number
 */
function assertCounter(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative whole number.`);
  }
}
