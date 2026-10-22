// Central Hub — the synchronisation engine.
//
// One adapter, one run. The engine opens the connection row, walks it through the
// contract's state machine, lets the adapter parse the payload, writes the
// observations the adapter produced — LINKED to the connection, so a disconnect
// removes exactly them — and closes the run record with what was seen, what was
// written and what was skipped.
//
// The engine is HONEST:
//   - a failed run is reported as a failure with its reason, never as a success;
//   - it never invents a record: the counters are the ones the database returned;
//   - a failed run leaves the previously imported data untouched.
//
// STATE MOVES
//   The contract's state machine (STATUS_TRANSITIONS) describes the flow of a
//   connection: disconnected -> connecting -> syncing -> connected, and "error"
//   when a step fails. The engine walks exactly that flow:
//     disconnected -> connecting -> syncing -> connected   (a first import)
//     error        -> connecting -> syncing -> connected   (a retry after a failure)
//     connected    -> syncing -> connected                   (a repeat import)
//   "connected" is reached only when the import is over, so the UI is never told
//   "connected" while data is still on its way in. A connection that is already
//   open goes straight to "syncing" — a repeat import reuses the open connection,
//   it does not reconnect it, so no "connected" -> "connecting" edge is needed.
//   Every single move is checked with assertLegalStatusTransition, so an illegal
//   move fails loudly instead of silently putting the row into a state the machine
//   forbids.
//
// This module is deliberately free of React: it is the data path the UI calls.

import {
  deleteIntegration,
  finishSyncRun,
  getIntegrationByProvider,
  startSyncRun,
  updateIntegrationStatus,
  upsertIntegration,
} from "../../lib/integrations.js";
import { insertObservations } from "../../lib/tracking.js";
import { assertLegalStatusTransition } from "./contract.js";
import { scopeObservationId } from "./ids.js";

/**
 * Runs one adapter synchronisation.
 *
 * The whole run is reported through the return value: the function does NOT throw
 * for a failed run, because a failed import is an outcome the user has to see, not
 * a crash of the app. A thrown error still means "the app could not do its job" and
 * is reserved for programming errors (a missing adapter, a malformed call).
 *
 * @param {object} options
 * @param {object} options.adapter an adapter with `parse(text)` and
 *   `toObservations(records)` (see ./contract.js)
 * @param {string} options.text the raw payload the adapter reads
 * @param {string} options.provider the adapter id, e.g. 'local_activity_file'
 * @param {string} [options.label] human-readable name of the connection
 * @param {object|null} [options.integration] the connection row, when the caller
 *   already has it (otherwise the engine looks the provider up, and creates the
 *   connection when there is none)
 * @param {((phase: string) => void)|null} [options.onProgress] called with
 *   'parsing', 'ingesting' and 'done' for the UI
 * @returns {Promise<{status: 'connected'|'error', integration: object|null, recordsSeen: number, recordsWritten: number, recordsSkipped: number, error: string|null}>}
 */
export async function runAdapterSync({
  adapter,
  text,
  provider,
  label,
  integration = null,
  onProgress = null,
}) {
  let row = integration ?? null;
  let currentStatus = row?.status ?? null;
  let run = null;

  try {
    if (!adapter || typeof adapter.parse !== "function" || typeof adapter.toObservations !== "function") {
      throw new Error("An adapter must provide parse() and toObservations().");
    }
    if (adapter.implemented === false) {
      throw new Error(
        `${adapter.label || adapter.id} is not available in this build, so it cannot import anything.`
      );
    }

    // (a) Resolve the connection: the row the caller brought, the one this user
    // already has for the provider, or a new one. There is exactly one connection
    // per (user, provider) — the upsert enforces it in the database.
    if (!row) {
      if (typeof provider !== "string" || provider.trim() === "") {
        throw new Error("A synchronisation needs a provider id.");
      }
      row = await getIntegrationByProvider(provider);
      if (!row) {
        row = await upsertIntegration({
          provider,
          label: label ?? null,
          status: "disconnected",
          config: {},
        });
      }
    }
    currentStatus = row.status;

    // (b) + (c) Move the connection into the state a run lives in. Only legal
    // transitions are taken; a status the machine cannot leave is an error
    // result, not a crash.
    const path = syncStartPath(currentStatus);
    if (!path) {
      throw new Error(
        `A synchronisation cannot start from the state "${currentStatus}".`
      );
    }
    for (const nextStatus of path) {
      assertLegalStatusTransition(currentStatus, nextStatus);
      row = await updateIntegrationStatus(row.id, { status: nextStatus });
      currentStatus = nextStatus;
    }

    // (d) Open the run record, so an interrupted attempt stays visible as 'running'.
    run = await startSyncRun({ integrationId: row.id });

    // (e) Let the adapter read the payload. A malformed payload throws here, and
    // nothing has been written yet, so the previously imported data is untouched.
    report(onProgress, "parsing");
    const { records } = adapter.parse(text);

    // (f) Map the records to observations and LINK every one of them to the
    // connection: the link is what makes a disconnect remove them.
    //
    // The id is SCOPED to the connection. `public.observations.id` is a global
    // primary key, but the adapter's id is derived from the record alone — so
    // two accounts importing the same file would collide and the second
    // account's import would be swallowed by the primary key, silently leaving
    // that account with no data at all. Scoping the id to the connection (one
    // connection per user and provider) keeps it unique per owner while
    // staying deterministic: the same connection importing the same file
    // always produces the same id, so a repeated import is still a no-op.
    const observations = adapter.toObservations(records).map((observation) => ({
      ...observation,
      id: scopeObservationId(observation.id, row.id),
      integrationId: row.id,
    }));

    // (g) Write them. The write is idempotent, so a repeated import writes
    // nothing new and reports the difference as "skipped".
    report(onProgress, "ingesting");
    const { inserted, skipped } = await insertObservations(observations);
    const recordsSeen = observations.length;
    const recordsWritten = inserted;
    const recordsSkipped = skipped;

    // (h) Close the run as successful, with the counters.
    await finishSyncRun(run.id, {
      status: "success",
      recordsSeen,
      recordsWritten,
      recordsSkipped,
    });

    // (i) The connection is up and the synchronisation is done.
    const syncedAt = new Date().toISOString();
    row = await updateIntegrationStatus(row.id, {
      status: "connected",
      lastError: null,
      lastSyncAt: syncedAt,
    });

    report(onProgress, "done");

    return {
      status: "connected",
      integration: row,
      recordsSeen,
      recordsWritten,
      recordsSkipped,
      error: null,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);

    // Close the run as failed. A run that cannot even be closed stays 'running',
    // which is the truth of an interrupted attempt.
    if (run) {
      try {
        await finishSyncRun(run.id, { status: "error", error: message });
      } catch {
        // The failure to record the failure must not hide the original reason.
      }
    }

    // Record the failure on the connection itself, through a legal path.
    if (row?.id) {
      try {
        row = await markConnectionFailed(row, currentStatus, message);
      } catch {
        // The database may be the reason the run failed; the returned result
        // still carries the reason, so the user is told the truth.
      }
    }

    return {
      status: "error",
      integration: row,
      recordsSeen: 0,
      recordsWritten: 0,
      recordsSkipped: 0,
      error: message,
    };
  }
}

/**
 * Disconnects a provider: removes the connection row.
 *
 * Removing the connection ALSO removes the observations that connection imported —
 * they are linked through `observations.integration_id` and the database removes
 * them with the row (ON DELETE CASCADE) — together with the run history. Nothing
 * else is touched: observations that were not imported by this connection stay.
 *
 * @param {object} integrationRow the connection row to remove
 * @returns {Promise<{ok: true}>}
 */
export async function disconnectIntegration(integrationRow) {
  const id = integrationRow?.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error("Disconnecting needs the connection row to remove.");
  }

  await deleteIntegration(id);

  return { ok: true };
}

/**
 * The legal moves that take a connection to the 'syncing' state.
 *
 * A connection that is not open yet — it is 'disconnected', or a previous run
 * left it in 'error' — is 'connecting' first, because the machine has no edge
 * from 'disconnected' straight to 'syncing'. A connection that is already
 * 'connected' goes straight to 'syncing': a repeat import reuses the open
 * connection, it does not reconnect it. A connection that is already 'syncing'
 * (an interrupted attempt) stays where it is — there is no 'syncing' -> 'syncing'
 * move, and the run continues in that state.
 *
 * @param {string} status the state the connection is in now
 * @returns {string[]|null} the states to move through, or null when the state is
 *   not one the machine knows
 */
function syncStartPath(status) {
  switch (status) {
    case "disconnected":
    case "error":
      return ["connecting", "syncing"];
    case "connecting":
    case "connected":
      return ["syncing"];
    case "syncing":
      return [];
    default:
      return null;
  }
}

/**
 * The legal moves that take a failing connection to the 'error' state.
 *
 * A run that fails while it is 'connecting' or 'syncing' goes straight to
 * 'error'. A connection that was still 'disconnected' has to be 'connecting'
 * first, because the machine does not allow a failure to be written onto a
 * state it cannot leave. A connection that was 'connected' reports the failed
 * attempt through 'syncing' — the run did start.
 *
 * @param {string} status the state the connection is in now
 * @returns {string[]|null} the states to move through, or null when the state is
 *   not one the machine knows
 */
function failurePath(status) {
  switch (status) {
    case "disconnected":
      return ["connecting", "error"];
    case "connecting":
    case "syncing":
      return ["error"];
    case "connected":
      return ["syncing", "error"];
    case "error":
      return [];
    default:
      return null;
  }
}

/**
 * Moves a failing connection to the 'error' state and stores the reason.
 *
 * The move follows the legal path (a connection that is still 'disconnected' has
 * to be 'connecting' first), because the state machine does not allow a failure
 * to be written onto a state it cannot leave.
 *
 * @param {object} row the connection row
 * @param {string} currentStatus the state the connection is in now
 * @param {string} message the failure reason
 * @returns {Promise<object>} the updated row
 */
async function markConnectionFailed(row, currentStatus, message) {
  const path = failurePath(currentStatus);

  if (!path) {
    // The connection is in a state the machine does not know: there is no legal
    // way to write 'error' onto it, so the row is left as it is. The failure is
    // still reported in the result the caller receives.
    return row;
  }

  let status = currentStatus;

  for (const nextStatus of path) {
    assertLegalStatusTransition(status, nextStatus);
    row = await updateIntegrationStatus(row.id, {
      status: nextStatus,
      lastError: message,
    });
    status = nextStatus;
  }

  if (path.length === 0) {
    // Already in the 'error' state: the reason is refreshed, the state stays.
    row = await updateIntegrationStatus(row.id, {
      status,
      lastError: message,
    });
  }

  return row;
}

/**
 * Reports a phase to the UI, without letting the UI break the run.
 *
 * A progress callback is feedback, not part of the data path: a callback that
 * throws must not abort an import that is already writing.
 *
 * @param {((phase: string) => void)|null} onProgress
 * @param {string} phase
 */
function report(onProgress, phase) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress(phase);
  } catch {
    // The run continues: the phase report is not worth failing an import for.
  }
}
