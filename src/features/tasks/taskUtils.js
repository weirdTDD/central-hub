// Sentral Hub — tasks domain: state machine, statuses, priorities, and row shaping.
//
// Serves MASTER_SPEC Section 7B: a task has a consistent state machine with
// validated transitions. Task status is INTENT (planned progress) and is kept
// separate from time-tracking status (work_logs).
//
// Transition rules (enforced client-side here; the DB CHECK constraint enforces
// valid status VALUES, and ownership is enforced by RLS in the database):
//
//   todo         -> in_progress | blocked
//   in_progress  -> in_review | completed | blocked | todo
//   in_review    -> completed | in_progress | blocked
//   blocked      -> in_progress | cancelled
//   completed    -> todo          (reopen)
//   cancelled    -> todo          (reactivate)
//
// active states are everything except completed/cancelled (i.e. work could resume).

export const TASK_STATUSES = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

export const ACTIVE_STATUSES = ["todo", "in_progress", "in_review", "blocked"];

export const TASK_PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const ALLOWED_TRANSITIONS = {
  todo: ["in_progress", "blocked"],
  in_progress: ["in_review", "completed", "blocked", "todo"],
  in_review: ["completed", "in_progress", "blocked"],
  blocked: ["in_progress", "cancelled"],
  completed: ["todo"],
  cancelled: ["todo"],
};

/** True when a status value is one of the valid machine states. */
function isValidStatus(status) {
  return TASK_STATUSES.some((s) => s.value === status);
}

/**
 * The statuses reachable from a given status, per the state machine.
 *
 * The UI drives its transitions from this list, so a control can never offer a move
 * the machine forbids.
 *
 * @param {string} status
 * @returns {string[]}
 */
export function allowedNextStatuses(status) {
  if (!isValidStatus(status)) return [];
  return ALLOWED_TRANSITIONS[status] ?? [];
}

/**
 * True when a transition from `from` to `to` is permitted by the task state
 * machine. Returns false for unknown statuses or disallowed moves.
 */
export function isValidStatusTransition(from, to) {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  if (from === to) return false;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Maps a database row to the camelCase shape the UI consumes.
 * `estimated_duration_seconds` is the canonical unit (integer seconds); a NULL
 * value means "not estimated", represented here as `null` (never 0).
 */
export function toTaskShape(row) {
  return {
    id: row.id,
    title: row.title ?? "",
    description: row.description ?? "",
    status: row.status ?? "todo",
    priority: row.priority ?? "medium",
    dueDate: row.due_date ?? null,
    estimatedSeconds:
      row.estimated_duration_seconds === null ||
      row.estimated_duration_seconds === undefined
        ? null
        : Number(row.estimated_duration_seconds),
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}
