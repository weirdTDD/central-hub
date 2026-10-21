// Central Hub — the workflow worker: the scheduler runtime.
//
// Serves MASTER_SPEC Section 7E: "persistent job scheduling", "idempotency and
// duplicate prevention", "retry policies and execution history", "cancellation and
// recovery after restart" and "do not depend on browser timers alone for reliable
// background execution".
//
// WHERE THE SCHEDULE LIVES: in the database (`workflows.next_run_at` and the
// `workflow_runs` history). The schedule therefore survives a restart of the app AND
// of this worker. WHAT RUNS IT: this process. If it is not running, nothing is
// executed — a limitation that is stated in the UI and in docs/TECHNICAL.md rather
// than hidden.
//
// HOW IT STAYS IDEMPOTENT: every occurrence gets a deterministic idempotency key
// (workflow id + occurrence) and a deterministic run id derived from it. The
// database's unique constraint on (user_id, idempotency_key) means the same
// occurrence can be executed only once, however many workers or retries race for it.
//
// WHICH USER IT RUNS AS: the signed-in user whose access token is supplied in
// CENTRAL_HUB_ACCESS_TOKEN. The worker therefore sees exactly the data that user may
// see (row-level security decides), and it needs no service-role secret.
//
// WHY it talks to PostgREST directly and not through @supabase/supabase-js: the
// browser client needs a global WebSocket (Node.js 22+), and a scheduler must not
// depend on the runtime of the UI. The REST API it calls is the same one the app
// uses, with the same headers.
//
// Usage:
//   node scripts/worker.mjs --once          # run a single tick and exit
//   node scripts/worker.mjs                  # run every CENTRAL_HUB_WORKER_INTERVAL_MS (default 30000)
//   node scripts/worker.mjs --interval=60000 # override the interval
//
// Required environment:
//   CENTRAL_HUB_URL         the Supabase project URL
//   CENTRAL_HUB_ANON_KEY    the anon (public) key
//   CENTRAL_HUB_ACCESS_TOKEN a signed-in user's access token

import {
  buildNotification,
  collectTaskEvents,
  idempotencyKey,
  nextRunAt,
  planDueRuns,
  planEventRuns,
  planRetry,
} from "../src/features/notifications/workflowEngine.js";
import { localDayKey } from "../src/lib/dates.js";
import { deterministicUuid } from "../src/lib/stableId.js";

const WORKFLOW_COLUMNS =
  "id,user_id,name,description,trigger_type,trigger_config,conditions,action_type,action_config,channel,enabled,requires_approval,max_attempts,retry_backoff_seconds,next_run_at,event_cursor,last_run_at,last_error,created_at,updated_at";
const RUN_COLUMNS =
  "id,user_id,workflow_id,idempotency_key,status,attempt,scheduled_for,next_attempt_at,started_at,finished_at,error,result,created_at,updated_at";

/**
 * Reads the worker's configuration from the environment.
 *
 * @returns {{url:string|null, anonKey:string|null, accessToken:string|null, missing:string[]}}
 */
function readConfig() {
  const url = process.env.CENTRAL_HUB_URL ?? process.env.SUPABASE_URL ?? null;
  const anonKey =
    process.env.CENTRAL_HUB_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? null;
  const accessToken = process.env.CENTRAL_HUB_ACCESS_TOKEN ?? null;

  const missing = [];
  if (!url) missing.push("CENTRAL_HUB_URL");
  if (!anonKey) missing.push("CENTRAL_HUB_ANON_KEY");
  if (!accessToken) missing.push("CENTRAL_HUB_ACCESS_TOKEN");

  return { url, anonKey, accessToken, missing };
}

/**
 * A tiny PostgREST client.
 *
 * WHY not the app's client: the browser client requires a global WebSocket, and the
 * worker must run on a plain Node runtime. The REST calls, the headers and the
 * `Prefer` options are the same ones the app sends.
 *
 * @param {{url:string, anonKey:string, accessToken:string}} config
 */
function createRestClient({ url, anonKey, accessToken }) {
  const base = `${url.replace(/\/+$/, "")}/rest/v1`;

  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  /**
   * Performs one request against the REST API.
   *
   * @param {string} path the table, with its query string
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {object|Array} [options.body]
   * @param {string} [options.prefer] the Prefer header
   * @param {string} [options.range] the Range header (the row window)
   * @returns {Promise<{rows: Array, count: number|null, error: string|null}>}
   */
  async function request(path, options = {}) {
    const response = await fetch(`${base}/${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...headers,
        ...(options.prefer ? { Prefer: options.prefer } : {}),
        ...(options.range ? { Range: options.range } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text();
    let rows = [];
    if (text) {
      try {
        rows = JSON.parse(text);
      } catch {
        rows = [];
      }
    }

    if (!response.ok) {
      // PostgREST reports {"code","details","hint","message"}; keep the whole body so
      // the failure is readable instead of "[object Object]".
      const message =
        typeof rows?.message === "string"
          ? rows.message
          : typeof rows?.error === "string"
            ? rows.error
            : `The request failed (${response.status}): ${text.slice(0, 300)}`;
      return { rows: [], count: null, error: message };
    }

    // PostgREST reports the true total in Content-Range: "0-199/1234".
    const contentRange = response.headers.get("Content-Range");
    const total = contentRange?.includes("/")
      ? Number(contentRange.split("/")[1])
      : null;

    return {
      rows: Array.isArray(rows) ? rows : rows ? [rows] : [],
      count: Number.isFinite(total) ? total : null,
      error: null,
    };
  }

  return {
    /** Reads rows from a table. */
    async select(table, query, { count = false, range = null } = {}) {
      const search = new URLSearchParams(query).toString();
      const result = await request(
        `${table}${search ? `?${search}` : ""}`,
        {
          prefer: count ? "count=exact" : undefined,
          range,
        }
      );
      return result;
    },

    /** Inserts rows and returns the rows the database actually wrote. */
    async insert(table, rows, { ignoreDuplicates = false } = {}) {
      const result = await request(table, {
        method: "POST",
        body: rows,
        prefer: `return=representation${
          ignoreDuplicates ? ",resolution=ignore-duplicates" : ""
        }`,
      });
      return result;
    },

    /** Updates the rows that match the filter. */
    async update(table, filter, values) {
      const result = await request(`${table}?${filter}`, {
        method: "PATCH",
        body: values,
        prefer: "return=representation",
      });
      return result;
    },
  };
}

/**
 * Writes a workflow run. The id is derived from the idempotency key, so a repeated
 * execution of the same occurrence is a no-op.
 *
 * @param {object} client
 * @param {object} values
 * @returns {Promise<{inserted:number, row:object|null, error:string|null}>}
 */
async function insertRun(client, values) {
  const result = await client.insert(
    "workflow_runs",
    [
      {
        id: values.id,
        workflow_id: values.workflowId,
        idempotency_key: values.idempotencyKey,
        status: values.status,
        attempt: values.attempt ?? 1,
        scheduled_for: values.scheduledFor,
        next_attempt_at: values.nextAttemptAt ?? null,
        started_at: values.startedAt ?? null,
        finished_at: values.finishedAt ?? null,
        error: values.error ?? null,
        result: values.result ?? {},
      },
    ],
    { ignoreDuplicates: true }
  );

  if (result.error) return { inserted: 0, row: null, error: result.error };
  return { inserted: result.rows.length, row: result.rows[0] ?? null, error: null };
}

/**
 * Updates a workflow run.
 *
 * @param {object} client
 * @param {string} id
 * @param {object} values
 * @returns {Promise<string|null>} an error message, or null on success
 */
async function updateRun(client, id, values) {
  const result = await client.update("workflow_runs", `id=eq.${id}`, values);
  return result.error;
}

/**
 * Delivers a notification through the in-app channel.
 *
 * The four states are written as four separate facts: SCHEDULED (planned), SENT
 * (handed to the channel), DELIVERED (the channel confirmed it — the row is in the
 * inbox) and, later, ACKNOWLEDGED (the user acted on it). A missing timestamp means
 * that step did not happen.
 *
 * @param {object} client
 * @param {object} notification
 * @returns {Promise<string|null>} an error message, or null on success
 */
async function deliverNotification(client, notification) {
  const inserted = await client.insert(
    "notifications",
    [
      {
        id: notification.id,
        workflow_id: notification.workflow_id,
        run_id: notification.run_id,
        channel: notification.channel,
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        status: "scheduled",
        scheduled_for: notification.scheduled_for,
        payload: notification.payload,
      },
    ],
    { ignoreDuplicates: true }
  );

  if (inserted.error) return inserted.error;

  const sent = await client.update("notifications", `id=eq.${notification.id}`, {
    status: "sent",
    sent_at: new Date().toISOString(),
  });
  if (sent.error) return sent.error;

  const delivered = await client.update(
    "notifications",
    `id=eq.${notification.id}`,
    { status: "delivered", delivered_at: new Date().toISOString() }
  );
  return delivered.error;
}

/**
 * Plans the next occurrence of a workflow and stores it.
 *
 * @param {object} client
 * @param {object} workflow
 * @param {string} occurrenceIso the occurrence that was just handled
 * @returns {Promise<string|null>} an error message, or null on success
 */
async function advanceSchedule(client, workflow, occurrenceIso) {
  const timezone = workflow.trigger_config?.timezone ?? "UTC";
  const next = nextRunAt(workflow.trigger_config, occurrenceIso, timezone);

  const result = await client.update(`workflows`, `id=eq.${workflow.id}`, {
    next_run_at: next,
    last_run_at: new Date().toISOString(),
    last_error: null,
  });
  return result.error;
}

/**
 * Executes one due workflow.
 *
 * @param {object} client
 * @param {object} entry a due entry from planDueRuns
 * @param {Date} now
 * @returns {Promise<object>} a summary of what happened
 */
async function executeDue(client, entry, now) {
  const { workflow, scheduledFor, deferredTo, evaluation } = entry;
  const key = idempotencyKey(workflow.id, scheduledFor);
  const runId = deterministicUuid(`workflow-run|${key}`);

  const inserted = await insertRun(client, {
    id: runId,
    workflowId: workflow.id,
    idempotencyKey: key,
    status: "scheduled",
    attempt: 1,
    scheduledFor,
  });

  if (inserted.error) {
    return { workflow: workflow.name, outcome: "failed", error: inserted.error };
  }

  if (inserted.inserted === 0) {
    // The occurrence has already been executed: the unique constraint did its job.
    return { workflow: workflow.name, outcome: "already-executed" };
  }

  const startedAt = new Date().toISOString();

  if (workflow.requires_approval) {
    await updateRun(client, runId, {
      status: "awaiting_approval",
      started_at: startedAt,
      result: { reason: "the workflow requires approval", deferred_to: deferredTo },
    });

    const approvalId = deterministicUuid(`approval|${runId}`);
    const approval = await client.insert(
      "approvals",
      [
        {
          id: approvalId,
          workflow_id: workflow.id,
          run_id: runId,
          kind: "workflow_action",
          payload: { workflow_name: workflow.name },
          status: "pending",
        },
      ],
      { ignoreDuplicates: true }
    );
    if (approval.error) {
      return { workflow: workflow.name, outcome: "failed", error: approval.error };
    }

    await advanceSchedule(client, workflow, scheduledFor);
    return { workflow: workflow.name, outcome: "awaiting-approval" };
  }

  try {
    const notification = buildNotification({
      workflow,
      run: { id: runId },
      evaluation,
      scheduledFor: deferredTo ?? scheduledFor,
    });

    const deliveryError = await deliverNotification(client, notification);
    if (deliveryError) throw new Error(deliveryError);

    await updateRun(client, runId, {
      status: "succeeded",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      result: {
        notification_id: notification.id,
        deferred_to: deferredTo,
        evaluations: evaluation?.evaluations ?? [],
      },
    });

    await advanceSchedule(client, workflow, scheduledFor);
    return { workflow: workflow.name, outcome: "succeeded", notificationId: notification.id };
  } catch (error) {
    const retry = planRetry({ run: { attempt: 1 }, workflow, now });

    await updateRun(client, runId, {
      status: retry.status,
      attempt: retry.attempt,
      next_attempt_at: retry.nextAttemptAt,
      started_at: startedAt,
      error: error?.message ?? "The run failed.",
    });

    await advanceSchedule(client, workflow, scheduledFor);
    return {
      workflow: workflow.name,
      outcome: retry.retry ? "retry-scheduled" : "failed",
      error: error?.message ?? "The run failed.",
    };
  }
}

/**
 * Executes a run that was waiting for approval.
 *
 * @param {object} client
 * @param {object} run
 * @param {object} workflow
 * @returns {Promise<object>} a summary
 */
async function executeApproved(client, run, workflow) {
  const approved = await client.select("approvals", {
    run_id: `eq.${run.id}`,
    status: "eq.approved",
    limit: 1,
  });
  if (approved.error) {
    return { workflow: workflow.name, outcome: "failed", error: approved.error };
  }

  if (!approved.rows.length) {
    const rejected = await client.select("approvals", {
      run_id: `eq.${run.id}`,
      status: "eq.rejected",
      limit: 1,
    });

    if (rejected.rows.length) {
      await updateRun(client, run.id, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        result: { reason: "the approval was rejected" },
      });
      return { workflow: workflow.name, outcome: "cancelled" };
    }

    return { workflow: workflow.name, outcome: "still-awaiting-approval" };
  }

  const notification = buildNotification({
    workflow,
    run,
    evaluation: run.result?.evaluations ?? null,
    scheduledFor: new Date().toISOString(),
  });

  const deliveryError = await deliverNotification(client, notification);
  if (deliveryError) {
    return { workflow: workflow.name, outcome: "failed", error: deliveryError };
  }

  await updateRun(client, run.id, {
    status: "succeeded",
    started_at: run.started_at ?? new Date().toISOString(),
    finished_at: new Date().toISOString(),
    result: { ...(run.result ?? {}), notification_id: notification.id },
  });

  await advanceSchedule(client, workflow, run.scheduled_for);
  return { workflow: workflow.name, outcome: "succeeded-after-approval" };
}

/**
 * Re-executes a run that failed and is waiting for its next attempt.
 *
 * The run row is REUSED (its id and its idempotency key stay the same), so a retry
 * can never produce a second execution of the same occurrence.
 *
 * @param {object} client
 * @param {object} run
 * @param {object} workflow
 * @returns {Promise<object>} a summary
 */
async function executeRetry(client, run, workflow) {
  const now = new Date();

  try {
    const notification = buildNotification({
      workflow,
      run,
      evaluation: run.result?.evaluations ?? null,
      scheduledFor: now.toISOString(),
    });

    const deliveryError = await deliverNotification(client, notification);
    if (deliveryError) throw new Error(deliveryError);

    await updateRun(client, run.id, {
      status: "succeeded",
      finished_at: new Date().toISOString(),
      next_attempt_at: null,
      error: null,
      result: { ...(run.result ?? {}), notification_id: notification.id },
    });

    return { workflow: workflow.name, outcome: "succeeded-on-retry" };
  } catch (error) {
    const retry = planRetry({ run, workflow, now });

    await updateRun(client, run.id, {
      status: retry.status,
      attempt: retry.attempt,
      next_attempt_at: retry.nextAttemptAt,
      error: error?.message ?? "The run failed.",
    });

    return {
      workflow: workflow.name,
      outcome: retry.retry ? "retry-scheduled" : "failed",
      error: error?.message ?? "The run failed.",
    };
  }
}

/**
 * Executes one EVENT of an event-triggered workflow.
 *
 * The run id is derived from the event's idempotency key, so the same completion
 * can never fire the same workflow twice — whatever the cursor says.
 *
 * @param {object} client
 * @param {object} entry a due entry from planEventRuns
 * @param {Date} now
 * @returns {Promise<object>} a summary of what happened
 */
async function executeEvent(client, entry, now) {
  const { workflow, event, scheduledFor, evaluation, idempotencyKey: key } = entry;
  const runId = deterministicUuid(`workflow-run|${key}`);

  const inserted = await insertRun(client, {
    id: runId,
    workflowId: workflow.id,
    idempotencyKey: key,
    status: "scheduled",
    attempt: 1,
    scheduledFor,
  });

  if (inserted.error) {
    return { workflow: workflow.name, outcome: "failed", error: inserted.error };
  }

  if (inserted.inserted === 0) {
    return { workflow: workflow.name, outcome: "already-executed" };
  }

  const startedAt = new Date().toISOString();

  if (workflow.requires_approval) {
    await updateRun(client, runId, {
      status: "awaiting_approval",
      started_at: startedAt,
      result: { reason: "the workflow requires approval", event: event.type },
    });

    const approval = await client.insert(
      "approvals",
      [
        {
          id: deterministicUuid(`approval|${runId}`),
          workflow_id: workflow.id,
          run_id: runId,
          kind: "workflow_action",
          payload: { workflow_name: workflow.name, event: event.type },
          status: "pending",
        },
      ],
      { ignoreDuplicates: true }
    );
    if (approval.error) {
      return { workflow: workflow.name, outcome: "failed", error: approval.error };
    }

    return { workflow: workflow.name, outcome: "awaiting-approval" };
  }

  try {
    const notification = buildNotification({
      workflow,
      run: { id: runId },
      evaluation,
      scheduledFor,
      event,
    });

    const deliveryError = await deliverNotification(client, notification);
    if (deliveryError) throw new Error(deliveryError);

    await updateRun(client, runId, {
      status: "succeeded",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      result: {
        notification_id: notification.id,
        event: event.type,
        task_id: event.taskId,
        evaluations: evaluation?.evaluations ?? [],
      },
    });

    return { workflow: workflow.name, outcome: "succeeded", notificationId: notification.id };
  } catch (error) {
    const retry = planRetry({ run: { attempt: 1 }, workflow, now });

    await updateRun(client, runId, {
      status: retry.status,
      attempt: retry.attempt,
      next_attempt_at: retry.nextAttemptAt,
      started_at: startedAt,
      error: error?.message ?? "The run failed.",
    });

    return {
      workflow: workflow.name,
      outcome: retry.retry ? "retry-scheduled" : "failed",
      error: error?.message ?? "The run failed.",
    };
  }
}

/**
 * Runs one tick of the worker.
 *
 * @param {object} client
 * @returns {Promise<object>} a summary of the tick
 */
export async function tick(client) {
  const now = new Date();

  const [workflowsResult, preferencesResult, tasksResult, sessionsResult] =
    await Promise.all([
      client.select(
        "workflows",
        { select: WORKFLOW_COLUMNS, enabled: "eq.true", order: "created_at.asc", limit: 200 },
        { count: true, range: "0-199" }
      ),
      client.select("notification_preferences", { select: "*", limit: 1 }),
      client.select(
        "tasks",
        {
          select: "id,title,due_date,status,priority,completed_at",
          limit: 500,
        },
        { range: "0-499" }
      ),
      client.select(
        "sessions",
        { select: "id,task_id", limit: 500 },
        { range: "0-499" }
      ),
    ]);

  for (const result of [workflowsResult, preferencesResult, tasksResult, sessionsResult]) {
    if (result.error) throw new Error(result.error);
  }

  const workflows = workflowsResult.rows;
  const preferences = preferencesResult.rows[0] ?? null;
  const timezone = preferences?.timezone ?? "UTC";

  const plan = planDueRuns({
    workflows,
    now,
    preferences,
    context: {
      today: localDayKey(now, timezone),
      tasks: tasksResult.rows,
      sessions: sessionsResult.rows,
    },
  });

  const results = [];

  // 1. The runs that are waiting for a decision.
  const awaiting = await client.select(
    "workflow_runs",
    { select: RUN_COLUMNS, status: "eq.awaiting_approval", limit: 100 },
    { range: "0-99" }
  );
  if (awaiting.error) throw new Error(awaiting.error);

  for (const run of awaiting.rows) {
    const workflow = workflows.find((item) => item.id === run.workflow_id);
    if (!workflow) continue;
    results.push(await executeApproved(client, run, workflow));
  }

  // 2. The occurrences that are due.
  for (const entry of plan.due) {
    results.push(await executeDue(client, entry, now));
  }

  // 3. The runs that failed and are waiting for their next attempt.
  const dueRetries = await client.select(
    "workflow_runs",
    {
      select: RUN_COLUMNS,
      status: "eq.scheduled",
      next_attempt_at: `lte.${now.toISOString()}`,
      limit: 100,
    },
    { range: "0-99" }
  );
  if (dueRetries.error) throw new Error(dueRetries.error);

  for (const run of dueRetries.rows) {
    const workflow = workflows.find((item) => item.id === run.workflow_id);
    if (!workflow) continue;
    results.push(await executeRetry(client, run, workflow));
  }

  // 4. The occurrences whose conditions did not hold: they are recorded as skipped
  //    and the schedule moves on, so the history shows why nothing was delivered.
  for (const skipped of plan.skipped) {
    if (skipped.reason !== "the conditions did not match") continue;
    const { workflow, evaluation } = skipped;
    const occurrence = workflow.next_run_at;
    const key = idempotencyKey(workflow.id, occurrence);
    const runId = deterministicUuid(`workflow-run|${key}`);

    const inserted = await insertRun(client, {
      id: runId,
      workflowId: workflow.id,
      idempotencyKey: key,
      status: "skipped",
      attempt: 1,
      scheduledFor: occurrence,
      finishedAt: new Date().toISOString(),
      result: { reason: skipped.reason, evaluations: evaluation?.evaluations ?? [] },
    });

    if (inserted.error) {
      results.push({ workflow: workflow.name, outcome: "failed", error: inserted.error });
      continue;
    }

    if (inserted.inserted > 0) {
      await advanceSchedule(client, workflow, occurrence);
      results.push({ workflow: workflow.name, outcome: "skipped" });
    }
  }

  // 4. The event triggers: the events that happened after the workflow's cursor.
  const eventWorkflows = workflows.filter(
    (workflow) => workflow.trigger_type === "event" && workflow.enabled
  );

  for (const workflow of eventWorkflows) {
    const events = collectTaskEvents({
      tasks: tasksResult.rows,
      since: workflow.event_cursor ?? null,
    });
    if (!events.length) continue;

    const eventPlan = planEventRuns({
      workflows: [workflow],
      events,
      context: {
        today: localDayKey(now, timezone),
        tasks: tasksResult.rows,
        sessions: sessionsResult.rows,
      },
    });

    for (const entry of eventPlan.due) {
      results.push(await executeEvent(client, entry, now));
    }

    // The events whose conditions did not hold are recorded as skipped, so the
    // history shows why nothing was delivered for them.
    for (const skipped of eventPlan.skipped) {
      const key = idempotencyKey(
        workflow.id,
        `event:${skipped.event.type}:${skipped.event.taskId}:${skipped.event.occurredAt}`
      );

      const inserted = await insertRun(client, {
        id: deterministicUuid(`workflow-run|${key}`),
        workflowId: workflow.id,
        idempotencyKey: key,
        status: "skipped",
        attempt: 1,
        scheduledFor: skipped.event.occurredAt,
        finishedAt: new Date().toISOString(),
        result: {
          reason: skipped.reason,
          evaluations: skipped.evaluation?.evaluations ?? [],
        },
      });

      if (inserted.error) {
        results.push({ workflow: workflow.name, outcome: "failed", error: inserted.error });
      } else if (inserted.inserted > 0) {
        results.push({ workflow: workflow.name, outcome: "skipped" });
      }
    }

    // The cursor moves past every event that was handled — including the skipped
    // ones, so the same event is not examined again on every tick.
    const lastEvent = events[events.length - 1];
    const cursor = await client.update(`workflows`, `id=eq.${workflow.id}`, {
      event_cursor: lastEvent.occurredAt,
    });
    if (cursor.error) {
      results.push({ workflow: workflow.name, outcome: "failed", error: cursor.error });
    }
  }

  return {
    at: now.toISOString(),
    workflows: workflows.length,
    due: plan.due.length,
    skipped: plan.skipped.length,
    results,
  };
}

/**
 * Runs the worker.
 *
 * @param {object} options {once, intervalMs}
 * @returns {Promise<number>} the process exit code
 */
export async function runWorker({ once = false, intervalMs = 30_000 } = {}) {
  const config = readConfig();

  if (config.missing.length > 0) {
    console.error(
      `Not connected: the worker is missing ${config.missing.join(", ")}. ` +
        "Set the values in the environment before starting it (see docs/TECHNICAL.md)."
    );
    return 1;
  }

  const client = createRestClient(config);

  // Prove the credentials work before claiming anything: an invalid token must be
  // reported, not worked around.
  const probe = await client.select("workflows", { select: "id", limit: 1 });
  if (probe.error) {
    console.error(`Not connected: ${probe.error}`);
    return 1;
  }

  const tickOnce = async () => {
    try {
      const summary = await tick(client);
      console.log(JSON.stringify(summary));
    } catch (error) {
      console.error(`The worker tick failed: ${error?.message ?? error}`);
    }
  };

  if (once) {
    await tickOnce();
    return 0;
  }

  console.log(
    `The workflow worker is running every ${intervalMs}ms. Press Ctrl+C to stop it.`
  );
  const timer = setInterval(tickOnce, intervalMs);
  await new Promise((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
  return 0;
}

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  const once = process.argv.includes("--once");
  const intervalArg = process.argv.find((argument) => argument.startsWith("--interval="));
  const intervalMs = intervalArg
    ? Number(intervalArg.split("=")[1])
    : Number(process.env.CENTRAL_HUB_WORKER_INTERVAL_MS) || 30_000;

  runWorker({ once, intervalMs })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`The worker stopped: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
}
