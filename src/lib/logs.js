import { supabase } from "./supabase";

const TABLE = "work_logs";

const COLUMNS =
  "id, title, notes, log_date, duration_seconds, display_name, created_at, updated_at";

/**
 * Maximum number of rows fetched in one page.
 *
 * PostgREST applies a server-side `max-rows` cap (1000 by default) and returns
 * a truncated list with no indication that anything was dropped, so the app
 * fetches a bounded page and reports the true total instead of silently
 * showing an incomplete history.
 */
export const LOGS_PAGE_SIZE = 500;

/**
 * Lists the signed-in user's work logs, most recent first.
 *
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listLogs({ limit = LOGS_PAGE_SIZE } = {}) {
  const { data, error, count } = await supabase
    .from(TABLE)
    .select(COLUMNS, { count: "exact" })
    .order("log_date", { ascending: false, nullsFirst: false })
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

export async function insertLog({ title, notes, logDate, durationSeconds, displayName }) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      title,
      notes: notes ?? null,
      log_date: logDate ?? null,
      duration_seconds: durationSeconds ?? null,
      display_name: displayName ?? null,
    })
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function updateLogRow(
  id,
  { title, notes, logDate, durationSeconds, displayName }
) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      title,
      notes: notes ?? null,
      log_date: logDate ?? null,
      duration_seconds: durationSeconds ?? null,
      ...(displayName === undefined ? {} : { display_name: displayName || null }),
    })
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteLogRow(id) {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}
