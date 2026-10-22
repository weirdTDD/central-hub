// Central Hub — the chat wire format shared by the app and the Edge Function.
//
// The browser speaks Server-Sent Events with this module. The function uses
// the same parser on xAI's stream, which is the OpenAI chat-completions shape:
// `data: {choices:[{delta}]}` and a final `data: [DONE]`.
//
// xAI documents that a streamed function call arrives whole in one chunk. The
// accumulator also accepts arguments split across chunks, which is what the
// chat-completions stream sends when a call is not whole.

/** How many stored turns are sent back to the model. */
export const MAX_MODEL_MESSAGES = 30;

/** How long one stored turn may be when it is sent again. */
export const MAX_MODEL_MESSAGE_LENGTH = 8000;

/**
 * Stored rows, in order, as chat-completions messages.
 *
 * System rows are dropped: the instruction is fixed by the function. A window
 * that would start on a tool result is extended backward so the tool call that
 * produced it is still in the list.
 *
 * @param {Array<object>} rows
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function modelMessages(rows, limit = MAX_MODEL_MESSAGES) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length === 0) return [];

  let start = Math.max(0, source.length - limit);
  while (start > 0 && source[start]?.role === "tool") start -= 1;

  const messages = [];
  for (const row of source.slice(start)) {
    const message = toApiMessage(row);
    if (message) messages.push(message);
  }
  return messages;
}

/**
 * Splits a text buffer into complete SSE events.
 *
 * The leftover is an event that has not finished yet (`\n\n` not seen).
 *
 * @param {string} buffer
 * @returns {{events: Array<{event: string, data: unknown}>, rest: string}}
 */
export function parseEventStream(buffer) {
  const text = typeof buffer === "string" ? buffer : "";
  const chunks = text.split(/\n\n/);
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
    if (raw === "[DONE]") {
      events.push({ event: "done", data: null });
      continue;
    }
    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      events.push({ event, data: raw });
    }
  }

  return { events, rest };
}

/**
 * Empty accumulator for one xAI completion.
 *
 * @returns {{text: string, toolCalls: Map<number, object>, finishReason: string|null}}
 */
export function createCompletionState() {
  return { text: "", toolCalls: new Map(), finishReason: null };
}

/**
 * Folds one chat-completions payload into the accumulator.
 *
 * @param {object} state
 * @param {object} payload
 * @returns {string} text added by this payload
 */
export function absorbCompletionChunk(state, payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return "";
  const delta = choice.delta ?? {};
  let added = "";

  if (typeof delta.content === "string" && delta.content) {
    state.text += delta.content;
    added += delta.content;
  }

  const fromDelta = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  const calls =
    fromDelta.length > 0
      ? fromDelta
      : Array.isArray(choice.message?.tool_calls)
        ? choice.message.tool_calls
        : [];
  calls.forEach((call, position) => absorbToolCall(state, call, position));

  if (typeof choice.message?.content === "string" && choice.message.content && !delta.content) {
    state.text += choice.message.content;
    added += choice.message.content;
  }

  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  return added;
}

/**
 * Tool calls accumulated so far, in index order, in the chat-completions shape.
 *
 * @param {object} state
 * @returns {Array<object>}
 */
export function completedToolCalls(state) {
  return [...state.toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .filter((call) => call.name)
    .map((call) => ({
      id: call.id || `call_${call.index}`,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments || "{}",
      },
    }));
}

/**
 * Reads an xAI SSE body (already buffered) into text and tool calls.
 *
 * Used by tests. The function reads the network stream and calls the same
 * two functions one chunk at a time.
 *
 * @param {string} sse
 * @returns {{text: string, toolCalls: Array<object>, finishReason: string|null}}
 */
export function readCompletionStream(sse) {
  const state = createCompletionState();
  const { events } = parseEventStream(sse.endsWith("\n\n") ? sse : `${sse}\n\n`);
  for (const event of events) {
    if (event.event === "done") continue;
    if (event.data && typeof event.data === "object") absorbCompletionChunk(state, event.data);
  }
  return {
    text: state.text,
    toolCalls: completedToolCalls(state),
    finishReason: state.finishReason,
  };
}

/**
 * @param {object} row
 * @returns {object|null}
 */
function toApiMessage(row) {
  if (!row || (row.role !== "user" && row.role !== "assistant" && row.role !== "tool")) {
    return null;
  }
  const content = clip(row.content);

  if (row.role === "user") {
    return content ? { role: "user", content } : null;
  }

  if (row.role === "tool") {
    if (!row.tool_call_id && !row.toolCallId) return null;
    return {
      role: "tool",
      tool_call_id: row.tool_call_id ?? row.toolCallId,
      content: content || "{}",
    };
  }

  const calls = Array.isArray(row.tool_calls)
    ? row.tool_calls
    : Array.isArray(row.toolCalls)
      ? row.toolCalls
      : null;
  const message = {
    role: "assistant",
    content: content || (calls && calls.length > 0 ? null : ""),
  };
  if (calls && calls.length > 0) message.tool_calls = calls;
  if (!message.content && !message.tool_calls) return null;
  return message;
}

/**
 * @param {object} state
 * @param {object} call
 * @param {number} position
 */
function absorbToolCall(state, call, position) {
  const index = Number.isInteger(call?.index) ? call.index : position;
  const current = state.toolCalls.get(index) ?? {
    index,
    id: "",
    name: "",
    arguments: "",
  };
  if (typeof call?.id === "string" && call.id) current.id = call.id;
  const name = call?.function?.name;
  if (typeof name === "string" && name) {
    if (!current.name || name.startsWith(current.name)) current.name = name;
    else if (!current.name.endsWith(name)) current.name += name;
  }
  const args = call?.function?.arguments;
  if (typeof args === "string" && args) current.arguments += args;
  state.toolCalls.set(index, current);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  if (typeof value !== "string") return "";
  return value.length > MAX_MODEL_MESSAGE_LENGTH
    ? value.slice(0, MAX_MODEL_MESSAGE_LENGTH)
    : value;
}
