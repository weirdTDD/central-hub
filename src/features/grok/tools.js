// Central Hub — the tools Grok may call, and the checks around them.
//
// The Edge Function executes these against the signed-in user's rows. This
// module decides whether a call is well-formed and what it means. It does not
// open a database connection: the function passes the reads and writes in.

import {
  REPEAT_RULES,
  matchTasks,
  validateAlertDraft,
  validateAlertPatch,
} from "./alerts.js";
import { CONTEXT_FOCUSES, CONTEXT_RANGES } from "./context.js";

/** Chat-completions tool definitions sent to xAI. */
export const GROK_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_owner_context",
      description:
        "Read this person's own tasks, work logs, coding time, learning time, and reminders. Call this before quoting any of those. Coding, learning, sessions, and work logs are separate. null seconds means nothing was measured.",
      parameters: {
        type: "object",
        properties: {
          range: {
            type: "string",
            enum: CONTEXT_RANGES,
            description: "today, this_week (Monday to Sunday), last_7_days, or last_30_days. Defaults to this_week.",
          },
          focus: {
            type: "array",
            items: { type: "string", enum: CONTEXT_FOCUSES },
            description: "Which records to include. Omit it to include all of them.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task_alert",
      description:
        "Create a reminder for one existing task. Use taskId when you already have it, or taskQuery as the words the person used. If several tasks match, this does not create a reminder.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "The task id from get_owner_context." },
          taskQuery: { type: "string", description: "The task name the person said, such as freeCodeCamp section." },
          dueAt: { type: "string", description: "When to remind them, as an ISO-8601 timestamp." },
          title: { type: "string", description: "Short reminder title. Optional." },
          note: { type: "string", description: "Optional note shown with the reminder." },
          repeat: { type: "string", enum: REPEAT_RULES, description: "none, daily, weekly, or weekdays." },
        },
        required: ["dueAt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_alert",
      description: "Change one of this person's reminders. id is required. Only include fields that should change.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          dueAt: { type: "string", description: "New ISO-8601 due time." },
          title: { type: "string" },
          note: { type: "string" },
          repeat: { type: "string", enum: REPEAT_RULES },
          status: { type: "string", enum: ["scheduled", "paused"] },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task_alert",
      description: "Delete one reminder. This does not delete the task.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_task_alerts",
      description: "List this person's scheduled and paused reminders.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const TOOL_NAMES = new Set(GROK_TOOLS.map((tool) => tool.function.name));

/**
 * Parses a tool call's arguments.
 *
 * @param {string} name
 * @param {unknown} raw a JSON string or an object
 * @returns {{ok: true, name: string, value: object, error: null}|{ok: false, name: string, value: null, error: string}}
 */
export function parseToolArguments(name, raw) {
  if (!TOOL_NAMES.has(name)) {
    return { ok: false, name: name ?? "", value: null, error: `"${name}" is not a tool Grok can use.` };
  }
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > 8000) {
      return { ok: false, name, value: null, error: "The tool arguments are too long." };
    }
    try {
      value = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return { ok: false, name, value: null, error: "The tool arguments were not JSON." };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, name, value: null, error: "The tool arguments must be an object." };
  }
  return { ok: true, name, value, error: null };
}

/**
 * Runs one tool call.
 *
 * `ctx` supplies the signed-in user's data:
 *   listTasks(), loadContext({range, focus}), listAlerts(),
 *   insertAlert(draft), updateAlert(id, patch), deleteAlert(id),
 *   now, timeZone.
 *
 * @param {string} name
 * @param {unknown} raw
 * @param {object} ctx
 * @returns {Promise<{ok: boolean, summary: string, data: object|null}>}
 */
export async function executeGrokTool(name, raw, ctx) {
  const parsed = parseToolArguments(name, raw);
  if (!parsed.ok) return { ok: false, summary: parsed.error, data: null };

  try {
    if (name === "get_owner_context") return await readContext(parsed.value, ctx);
    if (name === "create_task_alert") return await createAlert(parsed.value, ctx);
    if (name === "update_task_alert") return await updateAlert(parsed.value, ctx);
    if (name === "delete_task_alert") return await removeAlert(parsed.value, ctx);
    if (name === "list_task_alerts") return await listAlerts(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tool could not be run.";
    return { ok: false, summary: message, data: null };
  }

  return { ok: false, summary: `"${name}" is not a tool Grok can use.`, data: null };
}

/**
 * The JSON stored on a tool message and sent back to the model.
 *
 * @param {{ok: boolean, summary: string, data: object|null}} result
 * @returns {string}
 */
export function toolResultContent(result) {
  return JSON.stringify({
    ok: result.ok === true,
    summary: result.summary,
    data: result.data ?? null,
  });
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function readContext(args, ctx) {
  const range = CONTEXT_RANGES.includes(args.range) ? args.range : "this_week";
  const focus = Array.isArray(args.focus)
    ? args.focus.filter((item) => CONTEXT_FOCUSES.includes(item))
    : [];
  const snapshot = await ctx.loadContext({ range, focus });
  return {
    ok: true,
    summary: `Read your records for ${snapshot?.range?.label ?? range}.`,
    data: snapshot,
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function createAlert(args, ctx) {
  const tasks = await ctx.listTasks();
  const resolved = resolveTask(tasks, args);
  if (!resolved.ok) {
    return { ok: false, summary: resolved.summary, data: { matches: resolved.matches } };
  }

  const draft = validateAlertDraft(
    {
      taskId: resolved.task.id,
      taskTitle: resolved.task.title,
      title: args.title,
      note: args.note,
      dueAt: args.dueAt,
      repeat: args.repeat ?? "none",
      createdBy: "grok",
    },
    { now: ctx.now, timeZone: ctx.timeZone }
  );
  if (!draft.ok) return { ok: false, summary: draft.error, data: null };

  const row = await ctx.insertAlert(draft.value);
  const dueAt = row?.due_at ?? row?.dueAt ?? draft.value.dueAt;
  return {
    ok: true,
    summary: `Reminder set for "${resolved.task.title}" at ${dueAt}.`,
    data: { alert: publicAlert(row) },
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function updateAlert(args, ctx) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { ok: false, summary: "Which reminder should be changed?", data: null };

  const patch = validateAlertPatch(args, { now: ctx.now, timeZone: ctx.timeZone });
  if (!patch.ok) return { ok: false, summary: patch.error, data: null };

  const row = await ctx.updateAlert(id, patch.value);
  if (!row) return { ok: false, summary: "That reminder is not on your account.", data: null };
  return {
    ok: true,
    summary: `Updated the reminder "${row.title}".`,
    data: { alert: publicAlert(row) },
  };
}

/**
 * @param {object} args
 * @param {object} ctx
 */
async function removeAlert(args, ctx) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { ok: false, summary: "Which reminder should be deleted?", data: null };
  const removed = await ctx.deleteAlert(id);
  if (!removed) return { ok: false, summary: "That reminder is not on your account.", data: null };
  return { ok: true, summary: "The reminder was deleted. The task was left as it was.", data: { id } };
}

/**
 * @param {object} ctx
 */
async function listAlerts(ctx) {
  const rows = await ctx.listAlerts();
  const alerts = (rows ?? []).map(publicAlert);
  return {
    ok: true,
    summary: alerts.length === 0 ? "You have no reminders." : `You have ${alerts.length} reminders.`,
    data: { alerts },
  };
}

/**
 * @param {Array<object>} tasks
 * @param {object} args
 */
function resolveTask(tasks, args) {
  const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
  if (taskId) {
    const task = (tasks ?? []).find((item) => item?.id === taskId);
    if (!task) {
      return {
        ok: false,
        summary: "That task is not on your account.",
        matches: [],
      };
    }
    return { ok: true, task, matches: [] };
  }

  const query = typeof args.taskQuery === "string" ? args.taskQuery : "";
  if (!query.trim()) {
    return {
      ok: false,
      summary: "Say which task the reminder is for.",
      matches: [],
    };
  }

  const matched = matchTasks(tasks, query);
  if (matched.ok) return { ok: true, task: matched.task, matches: matched.matches };
  if (matched.reason === "many") {
    return {
      ok: false,
      summary: "More than one task matches. Ask which one, and do not create a reminder yet.",
      matches: matched.matches,
    };
  }
  return {
    ok: false,
    summary: "No task on this account matches that name. A reminder cannot create a task.",
    matches: [],
  };
}

/**
 * @param {object|null} row
 */
function publicAlert(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    taskId: row.task_id ?? row.taskId ?? null,
    title: row.title ?? "",
    note: row.note ?? null,
    dueAt: row.due_at ?? row.dueAt ?? null,
    repeat: row.repeat ?? "none",
    status: row.status ?? null,
    timezone: row.timezone ?? null,
  };
}
