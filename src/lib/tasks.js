// Central Hub — the tasks data layer.
//
// Tasks are the planned work of the app. This layer owns reading and writing the
// task rows; the UI never talks to the database directly.
//
// The rules of this layer (the same ones src/lib/tracking.js follows):
//   - EXPLICIT column lists, never select("*"): the shape of a row is decided
//     here, in one place.
//   - BOUNDED reads with an exact count: PostgREST truncates a large result set
//     silently, so a read reports the true total and whether the page is
//     truncated.

import { supabase } from "../lib/supabase";

const TABLE = "tasks";

const COLUMNS =
  "id, title, description, status, priority, due_date, estimated_duration_seconds, completed_at, created_at, updated_at";

/**
 * The columns a task REFERENCE needs.
 *
 * A picker only shows a task, its state and its PLAN, so the full task row
 * (description, due date, priority, ...) is not needed.
 *
 * WHY the estimate is here: the planned-vs-actual view compares the plan with
 * the recorded time, and the tracker only fetched id/title/status. The estimate
 * is the plan, so a reference without it cannot answer "against plan".
 */
const REFERENCE_COLUMNS =
  "id, title, status, estimated_duration_seconds, due_date, completed_at";

/**
 * Maximum rows fetched in one page.
 *
 * PostgREST applies a server-side `max-rows` cap (1000 by default) and returns a
 * truncated list with no indication anything was dropped, so the app fetches a
 * bounded page and reports the true total instead of silently showing an
 * incomplete list.
 */
export const TASKS_PAGE_SIZE = 500;

/**
 * Lists the signed-in user's tasks, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] page size (defaults to TASKS_PAGE_SIZE)
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listTasks({ limit = TASKS_PAGE_SIZE } = {}) {
  const { data, error, count } = await supabase
    .from(TABLE)
    .select(COLUMNS, { count: "exact" })
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
 * Lists lightweight task references for a picker.
 *
 * WHY a separate, narrower read: the tracking page needs a small task picker, but
 * mounting the full tasks provider there would fetch 500 complete task rows and
 * open a second realtime channel. This read fetches ONLY the columns the picker
 * needs, and follows the same bounded-read + exact-count convention as
 * `listTasks` (explicit column list, `count: "exact"`, a server-side limit, and a
 * `truncated` flag that tells the caller the list is incomplete).
 *
 * @param {object} [opts]
 * @param {number} [opts.limit] page size (defaults to TASKS_PAGE_SIZE)
 * @returns {Promise<{
 *   rows: Array<{
 *     id: string,
 *     title: string,
 *     status: string,
 *     estimatedSeconds: number|null
 *   }>,
 *   total: number|null,
 *   truncated: boolean
 * }>}
 *
 * `estimatedSeconds` is the task's PLAN in integer seconds. It is `null` when the
 * task has NO estimate ("not estimated") and never 0: a zero-length plan and a
 * missing plan are different facts.
 */
export async function listTaskReferences({ limit = TASKS_PAGE_SIZE } = {}) {
  const { data, error, count } = await supabase
    .from(TABLE)
    .select(REFERENCE_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  // WHY the rows are shaped here: the estimate is the task's PLAN, and the UI
  // needs it in the same camelCase unit it uses everywhere else. A task without
  // an estimate keeps `estimatedSeconds: null` — "not estimated" is missing
  // data, not a zero-second plan.
  const rows = (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    estimatedSeconds:
      row.estimated_duration_seconds === null ||
      row.estimated_duration_seconds === undefined
        ? null
        : Number(row.estimated_duration_seconds),
    dueDate: row.due_date ?? null,
    completedAt: row.completed_at ?? null,
  }));
  return {
    rows,
    total: count ?? null,
    truncated: count !== null && count > rows.length,
  };
}

/**
 * @param {{title:string, description?:string, status?:string, priority?:string, dueDate?:string|null, estimatedSeconds?:number|null}} values
 */
export async function insertTask(values) {
  const status = values.status ?? "todo";
  const { data, error } = await supabase.from(TABLE).insert({
    title: values.title?.trim() ?? "",
    description: values.description?.trim() || null,
    status,
    priority: values.priority ?? "medium",
    due_date: values.dueDate || null,
    estimated_duration_seconds:
      values.estimatedSeconds === null || values.estimatedSeconds === undefined
        ? null
        : Math.round(Number(values.estimatedSeconds)),
    // The database requires completed_at to agree with the status.
    completed_at: status === "completed" ? new Date().toISOString() : null,
  }).select(COLUMNS).single();

  if (error) throw error;
  return data;
}

export async function updateTask(id, values) {
  const payload = {};
  if (values.title !== undefined) payload.title = values.title?.trim() ?? "";
  if (values.description !== undefined)
    payload.description = values.description?.trim() || null;
  if (values.status !== undefined) {
    payload.status = values.status;
    // The database requires completed_at to agree with the status, so a status
    // change always carries the matching timestamp.
    if (values.completedAt === undefined) {
      payload.completed_at =
        values.status === "completed" ? new Date().toISOString() : null;
    }
  }
  if (values.priority !== undefined) payload.priority = values.priority;
  if (values.dueDate !== undefined) payload.due_date = values.dueDate || null;
  if (values.estimatedSeconds !== undefined) {
    payload.estimated_duration_seconds =
      values.estimatedSeconds === null || values.estimatedSeconds === undefined
        ? null
        : Math.round(Number(values.estimatedSeconds));
  }
  if (values.completedAt !== undefined) payload.completed_at = values.completedAt;

  const { data, error } = await supabase
    .from(TABLE)
    .update(payload)
    .eq("id", id)
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteTask(id) {
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}
