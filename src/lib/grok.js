// Central Hub — Grok chats and task reminders.
//
// The browser writes conversations, messages, and reminders here. A reply is
// asked of the grok-chat Edge Function, which holds the xAI key and reads this
// same user's rows. The browser does not call the provider.

import { supabase, supabaseAnonKey, supabaseUrl, isSupabaseConfigured } from "./supabase.js";

const CONVERSATION_COLUMNS = "id, title, model, created_at, updated_at";
const MESSAGE_COLUMNS =
  "id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, created_at";
const ALERT_COLUMNS =
  "id, task_id, title, note, due_at, timezone, repeat, status, last_fired_at, created_by, created_at, updated_at";

export const GROK_FUNCTION_NAME = "grok-chat";

/**
 * The function URL, or null when Supabase is not configured.
 *
 * @returns {string|null}
 */
export function grokFunctionUrl() {
  if (!isSupabaseConfigured || !supabaseUrl) return null;
  return `${String(supabaseUrl).replace(/\/$/, "")}/functions/v1/${GROK_FUNCTION_NAME}`;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listConversations() {
  const { data, error } = await supabase
    .from("grok_conversations")
    .select(CONVERSATION_COLUMNS)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {{title: string, model?: string|null}} values
 * @returns {Promise<object>}
 */
export async function insertConversation(values) {
  const { data, error } = await supabase
    .from("grok_conversations")
    .insert({
      title: values.title,
      model: values.model ?? null,
    })
    .select(CONVERSATION_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/**
 * @param {string} id
 * @param {object} values
 */
export async function updateConversation(id, values) {
  const payload = {};
  if ("title" in values) payload.title = values.title;
  if ("model" in values) payload.model = values.model;
  const { data, error } = await supabase
    .from("grok_conversations")
    .update(payload)
    .eq("id", id)
    .select(CONVERSATION_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/**
 * @param {string} id
 */
export async function deleteConversation(id) {
  const { data, error } = await supabase
    .from("grok_conversations")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * @param {string} conversationId
 * @returns {Promise<object[]>}
 */
export async function listMessages(conversationId) {
  const { data, error } = await supabase
    .from("grok_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {object} values
 * @returns {Promise<object>}
 */
export async function insertMessage(values) {
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
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/**
 * @returns {Promise<object[]>}
 */
export async function listTaskAlerts() {
  const { data, error } = await supabase
    .from("task_alerts")
    .select(ALERT_COLUMNS)
    .order("due_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

/**
 * Reminders that are still scheduled. The runner decides which of them are due.
 *
 * @returns {Promise<object[]>}
 */
export async function listScheduledAlerts() {
  const { data, error } = await supabase
    .from("task_alerts")
    .select(ALERT_COLUMNS)
    .eq("status", "scheduled")
    .order("due_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

/**
 * Task-alert notifications still held for quiet hours.
 *
 * @returns {Promise<object[]>}
 */
export async function listHeldTaskAlertNotifications() {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, kind, title, body, status, snoozed_until, payload")
    .eq("kind", "task_alert")
    .eq("status", "scheduled")
    .not("snoozed_until", "is", null)
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

/**
 * @param {object} draft the value returned by validateAlertDraft
 * @returns {Promise<object>}
 */
export async function insertTaskAlert(draft) {
  const { data, error } = await supabase
    .from("task_alerts")
    .insert({
      task_id: draft.taskId,
      title: draft.title,
      note: draft.note,
      due_at: draft.dueAt,
      timezone: draft.timezone,
      repeat: draft.repeat,
      created_by: draft.createdBy ?? "user",
    })
    .select(ALERT_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

/**
 * @param {string} id
 * @param {object} patch keys from validateAlertPatch, plus delivery fields
 * @returns {Promise<object|null>} null when no row was updated
 */
export async function updateTaskAlert(id, patch) {
  const payload = {};
  if ("title" in patch) payload.title = patch.title;
  if ("note" in patch) payload.note = patch.note;
  if ("dueAt" in patch) payload.due_at = patch.dueAt;
  if ("repeat" in patch) payload.repeat = patch.repeat;
  if ("status" in patch) payload.status = patch.status;
  if ("timezone" in patch) payload.timezone = patch.timezone;
  if ("lastFiredAt" in patch) payload.last_fired_at = patch.lastFiredAt;

  const { data, error } = await supabase
    .from("task_alerts")
    .update(payload)
    .eq("id", id)
    .select(ALERT_COLUMNS);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteTaskAlert(id) {
  const { data, error } = await supabase.from("task_alerts").delete().eq("id", id).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * The model the account last chose, or null when the preference is unset
 * or the column is not there yet.
 *
 * @returns {Promise<string|null>}
 */
export async function readGrokModelPreference() {
  const { data, error } = await supabase.from("ai_preferences").select("grok_model").maybeSingle();
  if (error) {
    if (isMissingColumn(error)) return null;
    throw error;
  }
  return data?.grok_model ?? null;
}

/**
 * @param {string|null} model
 * @returns {Promise<{saved: boolean}>}
 */
export async function writeGrokModelPreference(model) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  const userId = userData?.user?.id;
  if (!userId) throw new Error("You must be signed in.");

  const { error } = await supabase
    .from("ai_preferences")
    .upsert({ user_id: userId, grok_model: model }, { onConflict: "user_id" });
  if (error) {
    if (isMissingColumn(error) || isMissingTable(error)) return { saved: false };
    throw error;
  }
  return { saved: true };
}

/**
 * Asks the function whether the xAI key is set. This does not call the model.
 *
 * @returns {Promise<{ok: boolean, configured: boolean, model: string|null, error: string|null}>}
 */
export async function pingGrok() {
  const response = await postGrok({ ping: true });
  const body = await readJson(response);
  if (!response.ok || body?.ok !== true) {
    return {
      ok: false,
      configured: false,
      model: null,
      error: body?.error || unreachableMessage(response.status),
    };
  }
  return {
    ok: true,
    configured: true,
    model: typeof body.model === "string" ? body.model : null,
    error: null,
  };
}

/**
 * Streams one reply. Events are `{event, data}` from the function:
 * delta `{text}`, tool `{name, status, summary}`, done `{messageId, model}`,
 * error `{error}`.
 *
 * @param {object} input
 * @param {(event: {event: string, data: object}) => void} onEvent
 */
export async function streamGrokReply({ conversationId, model, timezone, signal }, onEvent) {
  const response = await postGrok(
    {
      conversationId,
      model: model || undefined,
      timezone: timezone || undefined,
    },
    signal
  );

  if (!response.ok) {
    const body = await readJson(response);
    throw new Error(body?.error || unreachableMessage(response.status));
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const body = await readJson(response);
    if (body?.error) throw new Error(body.error);
    throw new Error("Grok did not stream a reply.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawError = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = takeEvents(buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (event.event === "error" && event.data?.error) sawError = event.data.error;
      onEvent(event);
    }
  }

  if (sawError) throw new Error(sawError);
}

/**
 * @param {object} body
 * @param {AbortSignal} [signal]
 */
async function postGrok(body, signal) {
  const url = grokFunctionUrl();
  if (!url || !supabase) {
    throw new Error("Supabase is not configured, so Grok cannot be reached.");
  }
  const headers = await authHeaders();
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(unreachableMessage(0));
  }
}

/**
 * @returns {Promise<Record<string, string>>}
 */
async function authHeaders() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data?.session?.access_token;
  if (!token) throw new Error("You must be signed in.");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    apikey: supabaseAnonKey,
  };
}

/**
 * @param {Response} response
 */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * @param {number} status
 */
function unreachableMessage(status) {
  if (status === 404 || status === 0) {
    return "Grok is not reachable yet. Deploy the grok-chat function and set the XAI_API_KEY secret on it.";
  }
  return `Grok could not be reached (${status}).`;
}

/**
 * @param {string} buffer
 */
function takeEvents(buffer) {
  const chunks = buffer.split(/\n\n/);
  const rest = chunks.pop() ?? "";
  const events = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let event = "message";
    const dataLines = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      events.push({ event, data: { raw } });
    }
  }
  return { events, rest };
}

/**
 * @param {{code?: string, message?: string}} error
 */
function isMissingColumn(error) {
  return error?.code === "42703" || error?.code === "PGRST204" || /grok_model/.test(error?.message ?? "");
}

/**
 * @param {{code?: string, message?: string}} error
 */
function isMissingTable(error) {
  return error?.code === "42P01" || error?.code === "PGRST205";
}
