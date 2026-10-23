// Sentral Hub — the AI data layer.
//
// Serves MASTER_SPEC Section 7G. Every read is bounded and every write is
// owner-scoped by the database (RLS), never by the client.
//
// The reads follow the convention the rest of the app uses: an explicit column
// list, `count: "exact"`, a server-side limit, and a `truncated` flag that
// tells the caller the list is incomplete — so a short page is never mistaken
// for the whole history.

import { supabase } from "./supabase.js";

const RUNS_TABLE = "ai_runs";
const PROPOSALS_TABLE = "ai_classification_proposals";
const PREFERENCES_TABLE = "ai_preferences";

const RUN_COLUMNS =
  "id, kind, provider, model, status, input_digest, input, output, error, created_at, completed_at";
const PROPOSAL_COLUMNS =
  "id, run_id, observation_id, proposed_task_id, proposed_label, confidence, reason, status, decided_at, created_at, ai_runs(provider)";
const PREFERENCE_COLUMNS =
  "user_id, provider, include_window_titles, created_at, updated_at";

/** Maximum rows fetched in one page. */
export const AI_RUNS_PAGE_SIZE = 50;
export const AI_PROPOSALS_PAGE_SIZE = 100;

/**
 * Lists the signed-in user's analysis runs, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.kind] restrict to one capability
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listAiRuns({ limit = AI_RUNS_PAGE_SIZE, kind } = {}) {
  let query = supabase
    .from(RUNS_TABLE)
    .select(RUN_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (kind) query = query.eq("kind", kind);

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
 * Rejects an id that is not a uuid string.
 *
 * WHY this exists: a row object passed where an id is expected is stringified
 * by PostgREST into the query as "[object Object]", and the database then
 * answers `invalid input syntax for type uuid: "[object Object]"` — an error
 * that says nothing about what actually went wrong. The check turns it into a
 * message that names the mistake.
 *
 * @param {unknown} value
 * @param {string} label what the id identifies, for the message
 * @returns {string} the id
 * @throws {Error} when the value is not a non-empty string
 */
export function assertUuidId(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${label} must be a uuid string, not ${typeof value === "object" ? "an object" : typeof value}.`
    );
  }
  return value;
}

/**
 * Records that an analysis was started.
 *
 * The run is written BEFORE the provider is called, so an interrupted analysis
 * stays visible as 'running' — which is the truth of an attempt that never
 * finished.
 *
 * @param {object} values
 * @param {string} values.kind the capability that was requested
 * @param {string} values.provider
 * @param {string} values.model
 * @param {string} values.inputDigest identifies the evidence package that was sent
 * @param {object|null} [values.input] the evidence package itself
 * @returns {Promise<string>} the id of the created run
 */
export async function insertAiRun({ kind, provider, model, inputDigest, input = null }) {
  const { data, error } = await supabase
    .from(RUNS_TABLE)
    .insert({
      kind,
      provider,
      model,
      input_digest: inputDigest,
      input,
      status: "running",
    })
    .select(RUN_COLUMNS)
    .single();

  if (error) throw error;

  // The id, NOT the row: a caller that needs the whole row can read it back,
  // but a caller that passes this value to a query needs a uuid.
  return assertUuidId(data?.id, "The id of the new AI run");
}

/**
 * Closes a run with its outcome.
 *
 * A failed run is closed as a FAILURE with its reason. It is never closed as a
 * success, and the error text is kept so the user can see what went wrong.
 *
 * @param {string} id
 * @param {object} values
 * @param {"success"|"error"} values.status
 * @param {object|null} [values.output] the validated answer
 * @param {string|null} [values.error]
 * @returns {Promise<object>}
 */
export async function completeAiRun(id, { status, output = null, error = null }) {
  assertUuidId(id, "The id of the AI run to complete");

  const { data, error: updateError } = await supabase
    .from(RUNS_TABLE)
    .update({
      status,
      output,
      error,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(RUN_COLUMNS)
    .single();

  if (updateError) throw updateError;
  return data;
}

/**
 * Lists the signed-in user's classification proposals.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {"pending"|"approved"|"rejected"} [opts.status]
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listClassificationProposals({
  limit = AI_PROPOSALS_PAGE_SIZE,
  status,
} = {}) {
  let query = supabase
    .from(PROPOSALS_TABLE)
    .select(PROPOSAL_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) throw error;

  // The provider that produced a proposal is recorded on the run, so it is
  // read along with the proposal and flattened: the UI needs to know HOW the
  // suggestion was made, to record the attribution source honestly.
  const rows = (data ?? []).map((row) => ({
    ...row,
    provider: row.ai_runs?.provider ?? null,
  }));

  return {
    rows,
    total: count ?? null,
    truncated: count !== null && count > rows.length,
  };
}

/**
 * Records the proposals an analysis produced.
 *
 * @param {Array<object>} proposals
 * @param {string|null} [runId] the run that produced them
 * @returns {Promise<Array<object>>} the created rows
 */
export async function insertClassificationProposals(proposals = [], runId = null) {
  if (!Array.isArray(proposals) || proposals.length === 0) return [];

  if (runId !== null) assertUuidId(runId, "The id of the AI run that produced the proposals");

  const rows = proposals.map((proposal) => ({
    run_id: runId,
    observation_id: assertUuidId(
      proposal.observationId,
      "The id of the observation a proposal is about"
    ),
    proposed_task_id: proposal.taskId ?? null,
    proposed_label: proposal.label ?? null,
    confidence: proposal.confidence,
    reason: proposal.reason ?? null,
    status: "pending",
  }));

  const { data, error } = await supabase
    .from(PROPOSALS_TABLE)
    .insert(rows)
    .select(PROPOSAL_COLUMNS);

  if (error) throw error;
  return data ?? [];
}

/**
 * Records the user's decision on a proposal.
 *
 * This is the step that keeps an AI from silently changing task state: nothing
 * is applied to a task here, the proposal is only marked as decided. The
 * decision and the moment it was made are both stored.
 *
 * @param {string} id
 * @param {"approved"|"rejected"} status
 * @returns {Promise<object>}
 */
export async function decideClassificationProposal(id, status) {
  assertUuidId(id, "The id of the proposal to decide");

  const { data, error } = await supabase
    .from(PROPOSALS_TABLE)
    .update({ status, decided_at: new Date().toISOString() })
    .eq("id", id)
    .select(PROPOSAL_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * The signed-in user's AI preferences.
 *
 * @returns {Promise<{provider: string, includeWindowTitles: boolean}>} the
 *   defaults when the user has never saved any
 */
export async function readAiPreferences() {
  const { data, error } = await supabase
    .from(PREFERENCES_TABLE)
    .select(PREFERENCE_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  return {
    provider: data?.provider ?? "local",
    includeWindowTitles: data?.include_window_titles ?? false,
  };
}

/**
 * Saves the signed-in user's AI preferences.
 *
 * @param {object} values
 * @param {string} values.provider
 * @param {boolean} values.includeWindowTitles
 * @returns {Promise<object>}
 */
export async function saveAiPreferences({ provider, includeWindowTitles }) {
  // `user_id` is the primary key and takes its value from the session
  // (`default auth.uid()`), so the client never names the user — and the RLS
  // policy still decides whose row this is.
  const { data, error } = await supabase
    .from(PREFERENCES_TABLE)
    .upsert(
      {
        provider,
        include_window_titles: includeWindowTitles,
      },
      { onConflict: "user_id" }
    )
    .select(PREFERENCE_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}
