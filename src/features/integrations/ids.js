// Sentral Hub — integration identity helpers: stable hashing and deterministic ids.
//
// Serves MASTER_SPEC Section 7D: an adapter's records must be ingestible
// idempotently, and `public.observations.id` is a client-generated `uuid` primary
// key that doubles as the idempotency key. The id therefore has to be the SAME
// for the same input on every machine and every run — which is why it is derived
// from a stable hash of the record's identity instead of a random UUID.
//
// The hashing itself lives in src/lib/stableId.js, because the workflow domain
// (Phase 6) needs the same deterministic ids for its run and notification keys.
//
// This module is deliberately PURE (no React, no network, no browser APIs) so the
// rules can be verified with plain Node assertions — see scripts/verify-integrations.mjs.

import { deterministicUuid, stableHash } from "../../lib/stableId.js";

export { deterministicUuid, stableHash };

/**
 * Scopes a record id to the connection that imported it.
 *
 * WHY this exists: `public.observations.id` is a GLOBAL primary key, but the id
 * an adapter derives is based on the record ALONE. Two accounts that import the
 * same file would therefore produce the same id, and the second account's
 * import would be swallowed by the primary key — a silent loss of that user's
 * own data, reported as "nothing new was added". Scoping the id to the
 * connection (one connection per user and provider) makes it unique per owner
 * AND per provider.
 *
 * The id stays DETERMINISTIC: the same connection importing the same file
 * always produces the same id, so a repeated import is still a no-op.
 *
 * @param {string} recordId the id the adapter derived from the record
 * @param {string} connectionId the id of the connection that imports the record
 * @returns {string} a deterministic uuid
 */
export function scopeObservationId(recordId, connectionId) {
  return deterministicUuid(`${connectionId}|${recordId}`);
}
