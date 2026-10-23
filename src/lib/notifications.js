// Sentral Hub — the notifications and workflows data layer.
//
// Phase 6 (MASTER_SPEC Section 7E) persistence: workflow definitions, their
// execution history, the notifications they deliver, the delivery preferences and
// the approval requests.
//
// The rules of this layer:
//   - EXPLICIT column lists, never select("*"): the shape of a row is decided here.
//   - BOUNDED reads with an exact count: PostgREST truncates a large result set
//     silently, so a read reports the true total and whether the page is truncated.
//   - IDEMPOTENT WRITES where the record has a client-generated id: a repeated write
//     is a no-op and the layer reports how many rows were actually written.
//   - `if (error) throw error` — the layer reports a failure, it never hides one.

import { supabase } from "./supabase";

const WORKFLOWS_TABLE = "workflows";
const RUNS_TABLE = "workflow_runs";
const NOTIFICATIONS_TABLE = "notifications";
const PREFERENCES_TABLE = "notification_preferences";
const APPROVALS_TABLE = "approvals";

const WORKFLOW_COLUMNS =
  "id, user_id, name, description, trigger_type, trigger_config, conditions, action_type, action_config, channel, enabled, requires_approval, max_attempts, retry_backoff_seconds, next_run_at, event_cursor, last_run_at, last_error, created_at, updated_at";
const RUN_COLUMNS =
  "id, user_id, workflow_id, idempotency_key, status, attempt, scheduled_for, next_attempt_at, started_at, finished_at, error, result, created_at, updated_at";
const NOTIFICATION_COLUMNS =
  "id, user_id, workflow_id, run_id, channel, kind, title, body, status, scheduled_for, sent_at, delivered_at, acknowledged_at, snoozed_until, payload, created_at, updated_at";
const PREFERENCE_COLUMNS =
  "user_id, timezone, quiet_hours_start, quiet_hours_end, channels, kinds, created_at, updated_at";
const APPROVAL_COLUMNS =
  "id, user_id, workflow_id, run_id, kind, payload, status, decided_at, created_at, updated_at";

/** Maximum rows fetched in one page (PostgREST caps a result set at 1000 rows). */
export const NOTIFICATIONS_PAGE_SIZE = 200;

/**
 * Lists the user's notifications, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.status] restrict to one state
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listNotifications({ limit = NOTIFICATIONS_PAGE_SIZE, status = null } = {}) {
  let query = supabase
    .from(NOTIFICATIONS_TABLE)
    .select(NOTIFICATION_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);

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
 * Writes a notification. The id is CLIENT-GENERATED and deterministic, so a repeated
 * delivery of the same run is a no-op instead of a second message.
 *
 * @param {object} values
 * @returns {Promise<{inserted:number, skipped:number, row:object|null}>}
 */
export async function insertNotification(values = {}) {
  const { data, error } = await supabase
    .from(NOTIFICATIONS_TABLE)
    .upsert(
      {
        id: values.id,
        workflow_id: values.workflowId ?? values.workflow_id ?? null,
        run_id: values.runId ?? values.run_id ?? null,
        channel: values.channel ?? "in_app",
        kind: values.kind ?? "workflow",
        title: values.title ?? "Notification",
        body: values.body ?? null,
        status: values.status ?? "scheduled",
        scheduled_for: values.scheduledFor ?? values.scheduled_for ?? null,
        sent_at: values.sentAt ?? values.sent_at ?? null,
        delivered_at: values.deliveredAt ?? values.delivered_at ?? null,
        acknowledged_at: values.acknowledgedAt ?? values.acknowledged_at ?? null,
        snoozed_until: values.snoozedUntil ?? values.snoozed_until ?? null,
        payload: values.payload ?? {},
      },
      { onConflict: "id", ignoreDuplicates: true }
    )
    .select(NOTIFICATION_COLUMNS);

  if (error) throw error;

  const inserted = data?.length ?? 0;
  return { inserted, skipped: inserted === 0 ? 1 : 0, row: data?.[0] ?? null };
}

/**
 * Updates a notification — its state and the timestamps that go with it.
 *
 * @param {string} id
 * @param {object} values
 * @returns {Promise<object>} the updated row
 */
export async function updateNotification(id, values = {}) {
  const payload = {};
  if ("status" in values) payload.status = values.status;
  if ("scheduledFor" in values) payload.scheduled_for = values.scheduledFor;
  if ("sentAt" in values) payload.sent_at = values.sentAt;
  if ("deliveredAt" in values) payload.delivered_at = values.deliveredAt;
  if ("acknowledgedAt" in values) payload.acknowledged_at = values.acknowledgedAt;
  if ("snoozedUntil" in values) payload.snoozed_until = values.snoozedUntil;
  if ("payload" in values) payload.payload = values.payload;

  if (Object.keys(payload).length === 0) {
    throw new Error("No notification fields to update.");
  }

  const { data, error } = await supabase
    .from(NOTIFICATIONS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(NOTIFICATION_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deletes a notification (the user's right to remove what they were told).
 */
export async function deleteNotification(id) {
  const { error } = await supabase.from(NOTIFICATIONS_TABLE).delete().eq("id", id);
  if (error) throw error;
}

/**
 * Lists the user's workflows, most recently updated first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listWorkflows({ limit = NOTIFICATIONS_PAGE_SIZE } = {}) {
  const { data, error, count } = await supabase
    .from(WORKFLOWS_TABLE)
    .select(WORKFLOW_COLUMNS, { count: "exact" })
    .order("updated_at", { ascending: false })
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
 * Creates a workflow.
 *
 * @param {object} values
 * @returns {Promise<object>} the created row
 */
export async function insertWorkflow(values = {}) {
  const { data, error } = await supabase
    .from(WORKFLOWS_TABLE)
    .insert({
      name: values.name,
      description: values.description ?? null,
      trigger_type: values.triggerType ?? values.trigger_type ?? "schedule",
      trigger_config: values.triggerConfig ?? values.trigger_config ?? {},
      conditions: values.conditions ?? [],
      action_type: values.actionType ?? values.action_type ?? "create_notification",
      action_config: values.actionConfig ?? values.action_config ?? {},
      channel: values.channel ?? "in_app",
      enabled: values.enabled ?? true,
      requires_approval: values.requiresApproval ?? values.requires_approval ?? false,
      max_attempts: values.maxAttempts ?? values.max_attempts ?? 3,
      retry_backoff_seconds:
        values.retryBackoffSeconds ?? values.retry_backoff_seconds ?? 60,
      next_run_at: values.nextRunAt ?? values.next_run_at ?? null,
      event_cursor: values.eventCursor ?? values.event_cursor ?? null,
    })
    .select(WORKFLOW_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Updates a workflow — including switching it on or off.
 *
 * @param {string} id
 * @param {object} values
 * @returns {Promise<object>} the updated row
 */
export async function updateWorkflow(id, values = {}) {
  const payload = {};
  if ("name" in values) payload.name = values.name;
  if ("description" in values) payload.description = values.description;
  if ("triggerConfig" in values) payload.trigger_config = values.triggerConfig;
  if ("conditions" in values) payload.conditions = values.conditions;
  if ("actionConfig" in values) payload.action_config = values.actionConfig;
  if ("enabled" in values) payload.enabled = values.enabled;
  if ("requiresApproval" in values) payload.requires_approval = values.requiresApproval;
  if ("maxAttempts" in values) payload.max_attempts = values.maxAttempts;
  if ("retryBackoffSeconds" in values) {
    payload.retry_backoff_seconds = values.retryBackoffSeconds;
  }
  if ("nextRunAt" in values) payload.next_run_at = values.nextRunAt;
  if ("eventCursor" in values) payload.event_cursor = values.eventCursor;

  if (Object.keys(payload).length === 0) {
    throw new Error("No workflow fields to update.");
  }

  const { data, error } = await supabase
    .from(WORKFLOWS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(WORKFLOW_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deletes a workflow. Its runs and approvals are removed with it; the notifications
 * it produced stay, because a delivered message is a record of what the user was told.
 */
export async function deleteWorkflow(id) {
  const { error } = await supabase.from(WORKFLOWS_TABLE).delete().eq("id", id);
  if (error) throw error;
}

/**
 * Lists the user's workflow runs — the execution history — most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.workflowId] restrict to one workflow
 * @param {string} [opts.status] restrict to one state
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listWorkflowRuns({
  limit = NOTIFICATIONS_PAGE_SIZE,
  workflowId = null,
  status = null,
} = {}) {
  let query = supabase
    .from(RUNS_TABLE)
    .select(RUN_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (workflowId) query = query.eq("workflow_id", workflowId);
  if (status) query = query.eq("status", status);

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
 * Writes a workflow run. The id is CLIENT-GENERATED from the idempotency key, so the
 * unique constraint on (user_id, idempotency_key) makes a repeated execution a no-op.
 *
 * @param {object} values
 * @returns {Promise<{inserted:number, skipped:number, row:object|null}>}
 */
export async function insertWorkflowRun(values = {}) {
  const { data, error } = await supabase
    .from(RUNS_TABLE)
    .upsert(
      {
        id: values.id,
        workflow_id: values.workflowId ?? values.workflow_id,
        idempotency_key: values.idempotencyKey ?? values.idempotency_key,
        status: values.status ?? "scheduled",
        attempt: values.attempt ?? 1,
        scheduled_for: values.scheduledFor ?? values.scheduled_for,
        next_attempt_at: values.nextAttemptAt ?? values.next_attempt_at ?? null,
        started_at: values.startedAt ?? values.started_at ?? null,
        finished_at: values.finishedAt ?? values.finished_at ?? null,
        error: values.error ?? null,
        result: values.result ?? {},
      },
      { onConflict: "id", ignoreDuplicates: true }
    )
    .select(RUN_COLUMNS);

  if (error) throw error;

  const inserted = data?.length ?? 0;
  return { inserted, skipped: inserted === 0 ? 1 : 0, row: data?.[0] ?? null };
}

/**
 * Updates a workflow run — its state, its attempt count and its error.
 *
 * @param {string} id
 * @param {object} values
 * @returns {Promise<object>} the updated row
 */
export async function updateWorkflowRun(id, values = {}) {
  const payload = {};
  if ("status" in values) payload.status = values.status;
  if ("attempt" in values) payload.attempt = values.attempt;
  if ("nextAttemptAt" in values) payload.next_attempt_at = values.nextAttemptAt;
  if ("startedAt" in values) payload.started_at = values.startedAt;
  if ("finishedAt" in values) payload.finished_at = values.finishedAt;
  if ("error" in values) payload.error = values.error;
  if ("result" in values) payload.result = values.result;

  if (Object.keys(payload).length === 0) {
    throw new Error("No workflow run fields to update.");
  }

  const { data, error } = await supabase
    .from(RUNS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(RUN_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Lists the user's approval requests, most recent first.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.status]
 * @returns {Promise<{rows: Array, total: number|null, truncated: boolean}>}
 */
export async function listApprovals({
  limit = NOTIFICATIONS_PAGE_SIZE,
  status = null,
} = {}) {
  let query = supabase
    .from(APPROVALS_TABLE)
    .select(APPROVAL_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);

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
 * Writes an approval request.
 *
 * @param {object} values
 * @returns {Promise<{inserted:number, skipped:number, row:object|null}>}
 */
export async function insertApproval(values = {}) {
  const { data, error } = await supabase
    .from(APPROVALS_TABLE)
    .upsert(
      {
        id: values.id,
        workflow_id: values.workflowId ?? values.workflow_id ?? null,
        run_id: values.runId ?? values.run_id ?? null,
        kind: values.kind ?? "workflow_action",
        payload: values.payload ?? {},
        status: values.status ?? "pending",
        decided_at: values.decidedAt ?? values.decided_at ?? null,
      },
      { onConflict: "id", ignoreDuplicates: true }
    )
    .select(APPROVAL_COLUMNS);

  if (error) throw error;

  const inserted = data?.length ?? 0;
  return { inserted, skipped: inserted === 0 ? 1 : 0, row: data?.[0] ?? null };
}

/**
 * Records a decision on an approval request.
 *
 * @param {string} id
 * @param {object} values {status, decidedAt}
 * @returns {Promise<object>} the updated row
 */
export async function updateApproval(id, values = {}) {
  const payload = {};
  if ("status" in values) payload.status = values.status;
  if ("decidedAt" in values) payload.decided_at = values.decidedAt;

  if (Object.keys(payload).length === 0) {
    throw new Error("No approval fields to update.");
  }

  const { data, error } = await supabase
    .from(APPROVALS_TABLE)
    .update(payload)
    .eq("id", id)
    .select(APPROVAL_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Reads the user's delivery preferences.
 *
 * A missing row means "no preferences saved" — NOT "no quiet hours and no channels".
 *
 * @returns {Promise<object|null>}
 */
export async function listPreferences() {
  const { data, error } = await supabase
    .from(PREFERENCES_TABLE)
    .select(PREFERENCE_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Writes the user's delivery preferences.
 *
 * @param {object} values {timezone, quietHoursStart, quietHoursEnd, channels, kinds}
 * @returns {Promise<object>} the saved row
 */
export async function upsertPreferences(values = {}) {
  const { data, error } = await supabase
    .from(PREFERENCES_TABLE)
    .upsert(
      {
        user_id: values.userId,
        timezone: values.timezone ?? "UTC",
        quiet_hours_start: values.quietHoursStart ?? null,
        quiet_hours_end: values.quietHoursEnd ?? null,
        channels: values.channels ?? { in_app: true },
        kinds: values.kinds ?? {},
      },
      { onConflict: "user_id" }
    )
    .select(PREFERENCE_COLUMNS)
    .single();

  if (error) throw error;
  return data;
}
