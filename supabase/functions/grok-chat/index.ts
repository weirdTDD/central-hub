// Central Hub — grok-chat Edge Function.
//
// This is the only place a Grok conversation calls xAI.
//
//   1. THE KEY STAYS HERE. XAI_API_KEY is a Supabase secret. The browser asks
//      this function and never sees the key. A `VITE_` variable would be copied
//      into the public JavaScript bundle, so the key is not one of those.
//   2. THE ROWS ARE THE CALLER'S. The function uses the caller's JWT, so row
//      level security applies. Context tools read that user's tasks, logs,
//      coding time, and learning time. A client cannot ask for someone else's.
//   3. THE REPLY IS STREAMED. Tokens are forwarded as server-sent events.
//      Tool calls are run here, then the model continues.
//
// Configure it with:
//   supabase secrets set XAI_API_KEY=<your-xai-key>
//   supabase secrets set XAI_CHAT_MODEL=grok-4.7   # optional
//   supabase functions deploy grok-chat
//
// XAI_MODEL is used when XAI_CHAT_MODEL is unset, so one secret can serve the
// existing ai-analytics function and this chat. The chat default, when neither
// is set, is grok-4.7.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildOwnerContext } from "../../../src/features/grok/context.js";
import { resolveGrokModel } from "../../../src/features/grok/models.js";
import { systemPrompt } from "../../../src/features/grok/prompt.js";
import {
  absorbCompletionChunk,
  completedToolCalls,
  createCompletionState,
  modelMessages,
  parseEventStream,
} from "../../../src/features/grok/protocol.js";
import { executeGrokTool, GROK_TOOLS, toolResultContent } from "../../../src/features/grok/tools.js";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const MAX_ROUNDS = 4;
const MAX_COMPLETION_TOKENS = 1200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MESSAGE_COLUMNS =
  "id, role, content, tool_calls, tool_call_id, tool_name, created_at";
const ALERT_COLUMNS =
  "id, task_id, title, note, due_at, timezone, repeat, status, last_fired_at, created_by";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "Only POST is accepted." }, 405);
  }

  const apiKey = Deno.env.get("XAI_API_KEY");
  if (!apiKey) {
    return json(
      {
        ok: false,
        error: "The AI provider is not configured. Set the XAI_API_KEY secret on the function.",
      },
      503
    );
  }

  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization) return json({ ok: false, error: "You must be signed in." }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return json({ ok: false, error: "The function is not configured." }, 500);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return json({ ok: false, error: "You must be signed in." }, 401);

  let body: { ping?: boolean; conversationId?: string; model?: string; timezone?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "The request body must be JSON." }, 400);
  }

  if (body?.ping === true) {
    const resolved = resolveGrokModel("", configuredModel());
    if (!resolved.ok) return json({ ok: false, error: resolved.error }, 500);
    return json({ ok: true, configured: true, model: resolved.model });
  }

  const conversationId = typeof body?.conversationId === "string" ? body.conversationId.trim() : "";
  if (!UUID.test(conversationId)) {
    return json({ ok: false, error: "Choose a chat before asking Grok." }, 400);
  }

  const resolved = resolveGrokModel(body?.model, configuredModel());
  if (!resolved.ok) return json({ ok: false, error: resolved.error }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await runChat({
          supabase,
          userId: user.id,
          apiKey,
          conversationId,
          model: resolved.model,
          timeZone: cleanZone(body?.timezone),
          send,
        });
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        try {
          send("error", { error: message });
        } catch {
          // The browser has already gone. The error stays in the function log.
          console.error("grok-chat", message);
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      ...CORS,
    },
  });
});

/**
 * The model name from the function's environment.
 *
 * XAI_CHAT_MODEL wins. XAI_MODEL is the fallback shared with ai-analytics.
 */
function configuredModel() {
  return Deno.env.get("XAI_CHAT_MODEL") || Deno.env.get("XAI_MODEL") || "";
}

/**
 * One chat turn: stream text, run tools, stream the answer that follows.
 */
async function runChat({ supabase, userId, apiKey, conversationId, model, timeZone, send }) {
  const conversation = await loadConversation(supabase, userId, conversationId);
  if (!conversation) {
    send("error", { error: "That chat is not on your account." });
    return;
  }

  const history = await loadMessages(supabase, conversationId);
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    send("error", { error: "Type a message first." });
    return;
  }

  const now = new Date();
  const messages = [
    { role: "system", content: systemPrompt({ timeZone, now }) },
    ...modelMessages(history),
  ];
  const ctx = toolContext(supabase, userId, timeZone, now);

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outcome = await streamCompletion({ apiKey, model, messages, send });
    const calls = outcome.toolCalls;

    if (calls.length === 0) {
      const text = outcome.text.trim();
      if (!text) {
        send("error", { error: "Grok returned an empty reply." });
        return;
      }
      const saved = await insertMessage(supabase, {
        conversationId,
        role: "assistant",
        content: bound(text),
      });
      await touchConversation(supabase, conversationId, model);
      send("done", { messageId: saved.id, model });
      return;
    }

    await insertMessage(supabase, {
      conversationId,
      role: "assistant",
      content: bound(outcome.text),
      toolCalls: storedCalls(calls),
    });
    messages.push({
      role: "assistant",
      content: outcome.text.trim() ? outcome.text : null,
      tool_calls: storedCalls(calls),
    });

    for (const call of calls) {
      send("tool", { name: call.function.name, status: "running" });
      const result = await executeGrokTool(call.function.name, call.function.arguments, ctx);
      const content = bound(toolResultContent(result));
      await insertMessage(supabase, {
        conversationId,
        role: "tool",
        content,
        toolCallId: call.id,
        toolName: call.function.name,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content });
      send("tool", {
        name: call.function.name,
        status: "done",
        summary: result.summary,
        ok: result.ok === true,
      });
    }
  }

  send("error", { error: "Grok stopped after too many tool calls. Ask again in a shorter way." });
}

/**
 * Reads and writes used by the tools. Every query is the caller's, under RLS.
 */
function toolContext(supabase, userId, timeZone, now) {
  return {
    now,
    timeZone,
    listTasks: () => listTasks(supabase, userId),
    loadContext: ({ range, focus }) =>
      loadSnapshot(supabase, userId, { range, focus, timeZone, now }),
    listAlerts: () => listAlerts(supabase, userId),
    insertAlert: (draft) => insertAlert(supabase, draft),
    updateAlert: (id, patch) => updateAlertRow(supabase, id, patch),
    deleteAlert: (id) => deleteAlert(supabase, id),
  };
}

async function streamCompletion({ apiKey, model, messages, send }) {
  const response = await fetch(XAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      tools: GROK_TOOLS,
      tool_choice: "auto",
      messages,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(
      `The provider refused the request (${response.status}): ${redact(text).slice(0, 300)}`
    );
  }

  const state = createCompletionState();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const parsed = parseEventStream(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (!event.data || typeof event.data !== "object") continue;
      const added = absorbCompletionChunk(state, event.data);
      if (added) send("delta", { text: added });
    }
  }

  return {
    text: state.text,
    toolCalls: completedToolCalls(state),
  };
}

async function loadSnapshot(supabase, userId, { range, focus, timeZone, now }) {
  const since = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const [tasks, workLogs, coding, learning, sessions, alerts] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, description, status, priority, due_date, estimated_duration_seconds")
      .eq("user_id", userId)
      .limit(200),
    supabase
      .from("work_logs")
      .select("id, title, notes, log_date, duration_seconds")
      .eq("user_id", userId)
      .order("log_date", { ascending: false })
      .limit(200),
    supabase
      .from("observations")
      .select("id, occurred_at, duration_seconds, is_idle, project_name, editor")
      .eq("user_id", userId)
      .eq("activity_kind", "coding")
      .gte("occurred_at", since)
      .limit(1000),
    supabase
      .from("observations")
      .select("id, occurred_at, duration_seconds, is_idle, site_host, course_label, lesson_label")
      .eq("user_id", userId)
      .eq("activity_kind", "learning")
      .gte("occurred_at", since)
      .limit(1000),
    supabase
      .from("sessions")
      .select("id, started_at, task_id, duration_seconds")
      .eq("user_id", userId)
      .gte("started_at", since)
      .limit(500),
    supabase
      .from("task_alerts")
      .select("id, task_id, title, due_at, repeat, status")
      .eq("user_id", userId)
      .limit(50),
  ]);

  const snapshot = buildOwnerContext({
    tasks: rowsOf(tasks, "tasks"),
    workLogs: rowsOf(workLogs, "work logs"),
    coding: rowsOf(coding, "coding time"),
    learning: rowsOf(learning, "learning time"),
    sessions: rowsOf(sessions, "sessions"),
    alerts: rowsOf(alerts, "reminders"),
    now,
    timeZone,
    range,
    focus,
  });

  if ((coding.data ?? []).length >= 1000 && snapshot.coding) snapshot.coding.truncated = true;
  if ((learning.data ?? []).length >= 1000 && snapshot.learning) snapshot.learning.truncated = true;
  return snapshot;
}

async function listTasks(supabase, userId) {
  const result = await supabase
    .from("tasks")
    .select("id, title, description, status")
    .eq("user_id", userId)
    .limit(200);
  return rowsOf(result, "tasks");
}

async function listAlerts(supabase, userId) {
  const result = await supabase
    .from("task_alerts")
    .select(ALERT_COLUMNS)
    .eq("user_id", userId)
    .in("status", ["scheduled", "paused"])
    .order("due_at", { ascending: true })
    .limit(50);
  return rowsOf(result, "reminders");
}

async function insertAlert(supabase, draft) {
  const { data, error } = await supabase
    .from("task_alerts")
    .insert({
      task_id: draft.taskId,
      title: draft.title,
      note: draft.note,
      due_at: draft.dueAt,
      timezone: draft.timezone,
      repeat: draft.repeat,
      created_by: "grok",
    })
    .select(ALERT_COLUMNS)
    .single();
  if (error) throw new Error(`The reminder could not be saved: ${error.message}`);
  return data;
}

async function updateAlertRow(supabase, id, patch) {
  const payload: Record<string, unknown> = {};
  if ("title" in patch) payload.title = patch.title;
  if ("note" in patch) payload.note = patch.note;
  if ("dueAt" in patch) payload.due_at = patch.dueAt;
  if ("repeat" in patch) payload.repeat = patch.repeat;
  if ("status" in patch) payload.status = patch.status;
  if ("timezone" in patch) payload.timezone = patch.timezone;

  const { data, error } = await supabase
    .from("task_alerts")
    .update(payload)
    .eq("id", id)
    .select(ALERT_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`The reminder could not be updated: ${error.message}`);
  return data;
}

async function deleteAlert(supabase, id) {
  const { data, error } = await supabase.from("task_alerts").delete().eq("id", id).select("id");
  if (error) throw new Error(`The reminder could not be deleted: ${error.message}`);
  return (data ?? []).length > 0;
}

async function loadConversation(supabase, userId, conversationId) {
  const { data, error } = await supabase
    .from("grok_conversations")
    .select("id, title, model")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(missingTable(error, "Your chats"));
  return data;
}

async function loadMessages(supabase, conversationId) {
  const { data, error } = await supabase
    .from("grok_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(missingTable(error, "Your chats"));
  return data ?? [];
}

async function insertMessage(supabase, values) {
  const { data, error } = await supabase
    .from("grok_messages")
    .insert({
      conversation_id: values.conversationId,
      role: values.role,
      content: values.content ?? "",
      tool_calls: values.toolCalls ?? null,
      tool_call_id: values.toolCallId ?? null,
      tool_name: values.toolName ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`The reply could not be saved: ${error.message}`);
  return data;
}

async function touchConversation(supabase, conversationId, model) {
  const { error } = await supabase
    .from("grok_conversations")
    .update({ model })
    .eq("id", conversationId);
  if (error) console.error("grok conversation update failed", error.message);
}

function rowsOf(result, label) {
  if (result?.error) {
    throw new Error(`Your ${label} could not be read: ${result.error.message}`);
  }
  return result?.data ?? [];
}

function storedCalls(calls) {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: {
      name: String(call.function?.name ?? "").slice(0, 80),
      arguments: String(call.function?.arguments ?? "{}").slice(0, 8000),
    },
  }));
}

function bound(text) {
  const value = typeof text === "string" ? text : "";
  return value.length > 18000 ? `${value.slice(0, 18000)}…` : value;
}

function missingTable(error, label) {
  if (error?.code === "PGRST205" || error?.code === "42P01") {
    return `${label} are not in the database yet. Apply supabase/migrations/20261022160000_grok_chat_alerts.sql.`;
  }
  return error?.message || `${label} could not be read.`;
}

function cleanZone(value) {
  if (typeof value !== "string") return "UTC";
  const zone = value.trim();
  if (!/^[A-Za-z0-9_+/.-]{1,64}$/.test(zone)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return "UTC";
  }
}

function redact(text) {
  return String(text)
    .replace(/xai-[A-Za-z0-9_-]+/g, "xai-…")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-…");
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
