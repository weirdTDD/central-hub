// Central Hub — the time-tracking data layer.
//
// Phase 4 (MASTER_SPEC Section 7C) persistence: raw observations, the sessions
// derived from them, and the manual corrections that live beside a session.
//
// The rules of this layer:
//   - EXPLICIT column lists, never select("*"): the shape of a row is decided
//     here, in one place.
//   - BOUNDED reads with an exact count: PostgREST truncates a large result set
//     silently, so a read reports the true total and whether the page is
//     truncated.
//   - Times are stored in UTC; durations use ONE unit: integer seconds.

import { supabase } from "./supabase";
import { buildSessions } from "../features/tracking/sessionUtils";

const OBSERVATIONS_TABLE = "observations";
const SESSIONS_TABLE = "sessions";
const CORRECTIONS_TABLE = "session_corrections";

const OBSERVATION_COLUMNS =
  "id, source, occurred_at, ingested_at, duration_seconds, application, window_title, is_idle";
const SESSION_COLUMNS =
  "id, started_at, ended_at, duration_seconds, idle_seconds, source, application, timezone, task_id, attribution_source, attribution_confidence, observation_ids, created_at, updated_at";
const CORRECTION_COLUMNS =
  "id, session_id, previous_started_at, previous_ended_at, previous_duration_seconds, corrected_started_at, corrected_ended_at, corrected_duration_seconds, reason, created_at";

/**
 * Maximum rows fetched in one page.
 *
 * PostgREST applies a server-side `max-rows` cap (1000 by default) and returns a
 * truncated list with no indication that anything was dropped, so the app fetches a
 * bounded page and reports the true total instead of silently showing incomplete data.
 */
export const TRACKING_PAGE_SIZE = 500;

/**
 * Maximum rows fetched in one page of corrections.
 *
 * Same reasoning as TRACKING_PAGE_SIZE: PostgREST truncates silently, so the
 * read is bounded and the true total is reported alongside the page.
 */
export const TRACKING_CORRECTIONS_PAGE_SIZE = 500;

/**
 * Ingests observations idempotently.
 *
 * The caller generates the `id` (client-generated UUID) for every observation, and the
 * table uses that id as its primary key. Re-sending the same observations is therefore
 * a no-op: existing rows are left untouched and are not duplicated.
 *
 * @param {Array<object>} observations each observation may carry an optional
 *   `integrationId` (or `integration_id`), the connection that produced it
 * @returns {Promise<{inserted:number, skipped:number}>}
 */
export async function insertObservations(observations = []) {
  if (observations.length === 0) return { inserted: 0, skipped: 0 };

  const rows = observations.map((observation) => {
    const row = {
      id: observation.id ?? generateClientId(),
      source: observation.source ?? "manual",
      occurred_at: observation.occurredAt ?? observation.occurred_at,
      duration_seconds:
        observation.durationSeconds ?? observation.duration_seconds ?? null,
      application: observation.application ?? null,
      window_title: observation.windowTitle ?? observation.window_title ?? null,
      is_idle: observation.isIdle ?? observation.is_idle ?? false,
      // WHY: the column has NO default. An imported observation that does not carry
      // the link would keep integration_id = NULL and would SURVIVE a disconnect —
      // the cascade only removes the rows that point at the connection. NULL still
      // means "not produced by an integration" for the manual and collector paths.
      integration_id: observation.integrationId ?? observation.integration_id ?? null,
    };
    // Coding columns are sent only when the caller is actually recording coding
    // activity. Other inserts leave them off, so a database that has not applied
    // the coding migration still accepts manual and imported observations.
    const activityKind = observation.activityKind ?? observation.activity_kind ?? null;
    if (activityKind) row.activity_kind = activityKind;
    if (activityKind === "coding") {
      row.editor = observation.editor ?? null;
      row.project_name = observation.projectName ?? observation.project_name ?? null;
      row.language = observation.language ?? null;
      row.file_name = observation.fileName ?? observation.file_name ?? null;
    }
    if (activityKind === "learning") {
      row.site_host = observation.siteHost ?? observation.site_host ?? null;
      row.page_title = observation.pageTitle ?? observation.page_title ?? null;
      row.course_label = observation.courseLabel ?? observation.course_label ?? null;
      row.lesson_label = observation.lessonLabel ?? observation.lesson_label ?? null;
    }
    return row;
  });

  const { data, error } = await supabase
    .from(OBSERVATIONS_TABLE)
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true })
    .select(OBSERVATION_COLUMNS);

  if (error) throw error;

  const inserted = data?.length ?? 0;
  return { inserted, skipped: rows.length - inserted };
}

/**
 * Generates a client-side idempotency key.
 *
 * The key becomes the row's primary key, so re-sending the same record is a no-op
 * instead of creating a duplicate.
 */
function generateClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback for environments without the Web Crypto API.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

const CODING_OBSERVATION_COLUMNS =
  "id, source, occurred_at, ingested_at, duration_seconds, application, is_idle, activity_kind, editor, project_name, language, file_name, integration_id";

const LEARNING_OBSERVATION_COLUMNS =
  "id, source, occurred_at, ingested_at, duration_seconds, application, is_idle, activity_kind, site_host, page_title, course_label, lesson_label, integration_id";

/**
 * Lists coding heartbeats, oldest occurrence first.
 *
 * The coding timeline folds these into sessions. They are not the sessions
 * table: a manual work session and a coding heartbeat can describe the same
 * hour, and this read keeps them apart.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.from] ISO timestamp, inclusive
 * @param {string} [opts.to] ISO timestamp, exclusive
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listCodingObservations({
  limit = 1000,
  from,
  to,
} = {}) {
  let query = supabase
    .from(OBSERVATIONS_TABLE)
    .select(CODING_OBSERVATION_COLUMNS, { count: "exact" })
    .eq("activity_kind", "coding")
    .order("occurred_at", { ascending: true })
    .limit(limit);

  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lt("occurred_at", to);

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
 * Deletes the signed-in user's coding heartbeats in a time range.
 *
 * The delete is the user's control over collected coding data. It does not
 * touch manual observations or work sessions. A delete that matches nothing
 * returns deleted: 0 — that is a real outcome, not a success that removed rows.
 *
 * @param {object} range
 * @param {string} range.from inclusive ISO timestamp
 * @param {string} range.to exclusive ISO timestamp
 * @returns {Promise<{deleted: number}>}
 */
export async function deleteCodingObservations({ from, to }) {
  if (!from || !to) {
    throw new Error("Deleting coding activity needs a start and an end.");
  }
  const { data, error } = await supabase
    .from(OBSERVATIONS_TABLE)
    .delete()
    .eq("activity_kind", "coding")
    .gte("occurred_at", from)
    .lt("occurred_at", to)
    .select("id");

  if (error) throw error;
  return { deleted: data?.length ?? 0 };
}

const LEARNING_OBSERVATION_COLUMNS =
  "id, source, occurred_at, ingested_at, duration_seconds, application, is_idle, activity_kind, site_host, page_title, course_label, lesson_label, integration_id";

/**
 * Lists learning heartbeats, oldest occurrence first.
 *
 * Kept apart from coding heartbeats and from manual sessions.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.from]
 * @param {string} [opts.to]
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listLearningObservations({ limit = 1000, from, to } = {}) {
  let query = supabase
    .from(OBSERVATIONS_TABLE)
    .select(LEARNING_OBSERVATION_COLUMNS, { count: "exact" })
    .eq("activity_kind", "learning")
    .order("occurred_at", { ascending: true })
    .limit(limit);

  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lt("occurred_at", to);

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
 * Deletes learning heartbeats in a range. Coding and manual rows stay.
 *
 * @param {object} range
 * @returns {Promise<{deleted: number}>}
 */
export async function deleteLearningObservations({ from, to }) {
  if (!from || !to) {
    throw new Error("Deleting learning activity needs a start and an end.");
  }
  const { data, error } = await supabase
    .from(OBSERVATIONS_TABLE)
    .delete()
    .eq("activity_kind", "learning")
    .gte("occurred_at", from)
    .lt("occurred_at", to)
    .select("id");

  if (error) throw error;
  return { deleted: data?.length ?? 0 };
}

/**
 * Lists learning heartbeats, oldest occurrence first.
 *
 * The learning timeline folds these into sessions. They are not coding
 * heartbeats and they are not the sessions table.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.from] ISO timestamp, inclusive
 * @param {string} [opts.to] ISO timestamp, exclusive
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listLearningObservations({
  limit = 1000,
  from,
  to,
} = {}) {
  let query = supabase
    .from(OBSERVATIONS_TABLE)
    .select(LEARNING_OBSERVATION_COLUMNS, { count: "exact" })
    .eq("activity_kind", "learning")
    .order("occurred_at", { ascending: true })
    .limit(limit);

  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lt("occurred_at", to);

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
 * Deletes the signed-in user's learning heartbeats in a time range.
 *
 * The delete does not touch coding heartbeats or manual sessions. A delete
 * that matches nothing returns deleted: 0.
 *
 * @param {object} range
 * @param {string} range.from inclusive ISO timestamp
 * @param {string} range.to exclusive ISO timestamp
 * @returns {Promise<{deleted: number}>}
 */
export async function deleteLearningObservations({ from, to }) {
  if (!from || !to) {
    throw new Error("Deleting learning activity needs a start and an end.");
  }
  const { data, error } = await supabase
    .from(OBSERVATIONS_TABLE)
    .delete()
    .eq("activity_kind", "learning")
    .gte("occurred_at", from)
    .lt("occurred_at", to)
    .select("id");

  if (error) throw error;
  return { deleted: data?.length ?? 0 };
}

/**
 * Lists the signed-in user's observations, most recent occurrence first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.from] ISO timestamp, inclusive lower bound
 * @param {string} [opts.to] ISO timestamp, exclusive upper bound
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listObservations({ limit = TRACKING_PAGE_SIZE, from, to } = {}) {
  let query = supabase
    .from(OBSERVATIONS_TABLE)
    .select(OBSERVATION_COLUMNS, { count: "exact" })
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lt("occurred_at", to);

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
 * Lists the signed-in user's sessions, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.from] ISO timestamp, inclusive lower bound on started_at
 * @param {string} [opts.to] ISO timestamp, exclusive upper bound on started_at
 * @param {string|null} [opts.taskId] restrict to one task
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listSessions({
  limit = TRACKING_PAGE_SIZE,
  from,
  to,
  taskId = null,
} = {}) {
  let query = supabase
    .from(SESSIONS_TABLE)
    .select(SESSION_COLUMNS, { count: "exact" })
    .order("started_at", { ascending: false })
    .limit(limit);

  if (from) query = query.gte("started_at", from);
  if (to) query = query.lt("started_at", to);
  if (taskId) query = query.eq("task_id", taskId);

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
 * Creates a session (a time interval of work).
 *
 * `durationSeconds` may be null: a session with no measured coverage stores NULL
 * ("not recorded"), never 0.
 *
 * @param {object} values
 * @returns {Promise<object>} the created row
 */
export async function insertSession({
  startedAt,
  endedAt,
  durationSeconds = null,
  idleSeconds = null,
  source = "manual",
  application = null,
  timezone = "UTC",
  taskId = null,
  attributionSource = null,
  attributionConfidence = null,
  observationIds = null,
}) {
  if (durationSeconds !== null && durationSeconds !== undefined) {
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new Error("Session duration must be a non-negative number of seconds.");
    }
  }

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .insert({
      started_at: startedAt,
      ended_at: endedAt,
      duration_seconds:
        durationSeconds === null || durationSeconds === undefined
          ? null
          : Math.round(durationSeconds),
      idle_seconds:
        idleSeconds === null || idleSeconds === undefined ? null : Math.round(idleSeconds),
      source,
      application,
      timezone,
      task_id: taskId,
      attribution_source: attributionSource,
      attribution_confidence: attributionConfidence,
      observation_ids: observationIds,
    })
    .select(SESSION_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Updates the attribution of a session. Only the provided fields are written, so a
 * caller can change the task, the source, or the confidence without clearing the others.
 *
 * @param {string} id
 * @param {object} values
 * @param {string|null} [values.taskId]
 * @param {string|null} [values.attributionSource]
 * @param {number|null} [values.attributionConfidence]
 * @returns {Promise<object>} the updated row
 */
export async function updateSessionAttribution(id, values = {}) {
  const payload = {};
  if ("taskId" in values) payload.task_id = values.taskId;
  if ("attributionSource" in values) payload.attribution_source = values.attributionSource;
  if ("attributionConfidence" in values) {
    payload.attribution_confidence = values.attributionConfidence;
  }

  if (Object.keys(payload).length === 0) {
    throw new Error("No attribution fields to update.");
  }

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(SESSION_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Finds the session that was built from an observation.
 *
 * WHY this exists: a classification proposal is about an OBSERVATION, but
 * attribution lives on the SESSION. The session that contains the observation
 * is the one that has to be attributed, so the two are joined here rather than
 * in the UI.
 *
 * `observation_ids` is a `uuid[]`, so the join is a server-side `@>` and not a
 * scan of the caller's sessions.
 *
 * @param {string} observationId
 * @returns {Promise<object|null>} the session, or null when the observation
 *   belongs to no session
 */
export async function findSessionByObservationId(observationId) {
  if (typeof observationId !== "string" || observationId.trim() === "") {
    throw new Error("Finding a session needs an observation id.");
  }

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select(SESSION_COLUMNS)
    .contains("observation_ids", [observationId])
    .limit(1);

  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Deletes a session. Its corrections are removed with it (ON DELETE CASCADE).
 *
 * WHY the RETURNING clause: a delete that matches no row is NOT an error in
 * PostgREST — the request succeeds and no row is touched. The caller would then
 * report "the session was deleted" while the row is still in the table, so the
 * outcome is read back instead of assumed.
 *
 * @param {string} id
 */
export async function deleteSession(id) {
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .delete()
    .eq("id", id)
    .select("id");

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("The session was not deleted.");
  }
}

/**
 * Records a manual correction as its own row.
 *
 * The session keeps its observed values; the correction travels beside it, so the
 * original stays auditable. The row carries a CLIENT-GENERATED id, so re-sending the
 * same correction is a no-op instead of creating a duplicate.
 *
 * The corrected duration must match the corrected interval: a correction that claims
 * a duration its own time range contradicts is rejected.
 *
 * @param {object} correction
 * @returns {Promise<object>} the created row
 */
export async function insertSessionCorrection({
  id,
  sessionId,
  previousStartedAt = null,
  previousEndedAt = null,
  previousDurationSeconds = null,
  correctedStartedAt,
  correctedEndedAt,
  correctedDurationSeconds,
  reason = null,
}) {
  const start = Date.parse(correctedStartedAt);
  const end = Date.parse(correctedEndedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error("A correction needs a valid start and end time.");
  }

  const intervalSeconds = Math.round((end - start) / 1000);
  if (
    correctedDurationSeconds !== null &&
    correctedDurationSeconds !== undefined &&
    Math.abs(correctedDurationSeconds - intervalSeconds) > 1
  ) {
    throw new Error(
      `The corrected duration (${correctedDurationSeconds}s) does not match the corrected interval (${intervalSeconds}s).`
    );
  }

  const { data, error } = await supabase
    .from(CORRECTIONS_TABLE)
    .upsert(
      {
        id: id ?? generateClientId(),
        session_id: sessionId,
        previous_started_at: previousStartedAt,
        previous_ended_at: previousEndedAt,
        previous_duration_seconds: previousDurationSeconds,
        corrected_started_at: correctedStartedAt,
        corrected_ended_at: correctedEndedAt,
        corrected_duration_seconds:
          correctedDurationSeconds === null || correctedDurationSeconds === undefined
            ? intervalSeconds
            : Math.round(correctedDurationSeconds),
        reason,
      },
      { onConflict: "id", ignoreDuplicates: true }
    )
    .select(CORRECTION_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Lists the corrections recorded for a session, oldest first.
 *
 * @param {string} sessionId
 * @returns {Promise<Array<object>>}
 */
export async function listSessionCorrections(sessionId) {
  const { data, error } = await supabase
    .from(CORRECTIONS_TABLE)
    .select(CORRECTION_COLUMNS)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

/**
 * Lists the signed-in user's corrections, most recent first.
 *
 * WHY a bulk read: the tracking page shows the EFFECTIVE (corrected) values of
 * the sessions it lists. Fetching the corrections of each session separately
 * would be one query per session. `listSessionCorrections(sessionId)` stays as it
 * is — it is still the per-session read.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] page size (defaults to TRACKING_CORRECTIONS_PAGE_SIZE)
 * @returns {Promise<{rows: Array<object>, total: number|null, truncated: boolean}>}
 */
export async function listRecentCorrections({
  limit = TRACKING_CORRECTIONS_PAGE_SIZE,
} = {}) {
  const { data, error, count } = await supabase
    .from(CORRECTIONS_TABLE)
    .select(CORRECTION_COLUMNS, { count: "exact" })
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
 * Updates the measured coverage of a session after its observations changed.
 *
 * `durationSeconds` may be null, meaning "no measured coverage" (missing, never 0).
 */
export async function updateSessionCoverage(
  id,
  { durationSeconds = null, idleSeconds = null, observationIds = null } = {}
) {
  const payload = {};
  if (durationSeconds !== undefined) {
    payload.duration_seconds =
      durationSeconds === null ? null : Math.round(durationSeconds);
  }
  if (idleSeconds !== undefined) {
    payload.idle_seconds = idleSeconds === null ? null : Math.round(idleSeconds);
  }
  if (observationIds !== undefined) payload.observation_ids = observationIds;

  if (Object.keys(payload).length === 0) {
    throw new Error("No coverage fields to update.");
  }

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(SESSION_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deletes a single observation (the user's right to remove collected data).
 *
 * The sessions that the observation fed are RECOMPUTED from the observations that
 * remain, so removed time stops being counted and no session keeps a dangling
 * reference to a deleted observation. The sessions themselves (and their attribution
 * and corrections) are preserved.
 */
export async function deleteObservation(id) {
  const { error: readError } = await supabase
    .from(OBSERVATIONS_TABLE)
    .select(OBSERVATION_COLUMNS)
    .eq("id", id)
    .single();

  if (readError) throw readError;

  const { data: affectedSessions, error: sessionsError } = await supabase
    .from(SESSIONS_TABLE)
    .select(SESSION_COLUMNS)
    .contains("observation_ids", [id]);

  if (sessionsError) throw sessionsError;

  const { error: deleteError } = await supabase
    .from(OBSERVATIONS_TABLE)
    .delete()
    .eq("id", id);

  if (deleteError) throw deleteError;

  for (const session of affectedSessions ?? []) {
    const { data: remaining, error: remainingError } = await supabase
      .from(OBSERVATIONS_TABLE)
      .select(OBSERVATION_COLUMNS)
      .gte("occurred_at", session.started_at)
      .lte("occurred_at", session.ended_at);

    if (remainingError) throw remainingError;

    const rebuilt = buildSessions(remaining ?? []);
    const coverage = rebuilt.reduce(
      (sum, s) => sum + (s.durationSeconds ?? 0),
      0
    );
    const idle = rebuilt.reduce((sum, s) => sum + (s.idleSeconds ?? 0), 0);

    await updateSessionCoverage(session.id, {
      durationSeconds: coverage > 0 ? coverage : null,
      idleSeconds: idle,
      observationIds: rebuilt.flatMap((s) => s.observationIds),
    });
  }
}
