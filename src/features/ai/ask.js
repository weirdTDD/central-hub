// Sentral Hub — a question asked of the user's own records.
//
// The chat sends a question. It does not send a new capability to invent
// sessions or to change a task. The question and the earlier turns are text
// the user already saw; the records themselves are rebuilt by the function
// from the signed-in user's rows.
//
// This module is pure so the same limits apply in the browser and in the
// Edge Function.

/** How long one question may be. A longer question is refused, not truncated. */
export const MAX_QUESTION_LENGTH = 2000;

/** Earlier turns sent with the next question. Older turns are dropped. */
export const MAX_HISTORY_MESSAGES = 8;

/** How much of one earlier turn is kept. */
export const MAX_HISTORY_MESSAGE_LENGTH = 1500;

/** Planned-versus-actual rows included with a question. */
export const MAX_PLAN_ROWS = 40;

/**
 * Turns a report date range into the bounds the chat asks about.
 *
 * `to` is the start of the last day the report shows. The bound returned is
 * the start of the next local day, because session queries treat `to` as
 * exclusive. Passing the report's `to` through unchanged would drop that day.
 *
 * @param {Date|string|null|undefined} from
 * @param {Date|string|null|undefined} to
 * @returns {{from: string|null, to: string|null}}
 */
export function reportRangeBounds(from, to) {
  return {
    from: instantIso(from),
    to: exclusiveNextLocalDayIso(to),
  };
}

/**
 * Checks a chat request before it is sent or answered.
 *
 * A system turn is dropped: the instruction to the model is fixed, and a
 * client must not be able to replace it by putting a system message in the
 * history.
 *
 * @param {{question?: unknown, history?: unknown}} body
 * @returns {{ok: true, question: string, history: Array<{role: "user"|"assistant", content: string}>, error: null}|{ok: false, question: "", history: [], error: string}}
 */
export function prepareAskRequest(body) {
  const question = collapse(body?.question);
  if (!question) {
    return { ok: false, question: "", history: [], error: "Type a question first." };
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return {
      ok: false,
      question: "",
      history: [],
      error: `A question can be at most ${MAX_QUESTION_LENGTH} characters.`,
    };
  }

  const incoming = Array.isArray(body?.history) ? body.history : [];
  const history = [];
  for (const message of incoming) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = collapse(message.content).slice(0, MAX_HISTORY_MESSAGE_LENGTH);
    if (!content) continue;
    history.push({ role: message.role, content });
  }

  return {
    ok: true,
    question,
    history: history.slice(-MAX_HISTORY_MESSAGES),
    error: null,
  };
}

/**
 * The planned-versus-actual figures a question is allowed to see.
 *
 * Seconds stay seconds. A missing estimate stays null. The note tells the
 * model that these figures come from sessions and must not be added to the
 * work-log totals in the same package.
 *
 * @param {{rows?: Array<object>, totals?: object}|null|undefined} summary
 * @returns {object}
 */
export function compactPlan(summary) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const shown = rows.slice(0, MAX_PLAN_ROWS).map((row) => ({
    taskId: row?.taskId ?? null,
    title: typeof row?.title === "string" ? row.title : "",
    status: row?.status ?? null,
    plannedSeconds: numberOrNull(row?.plannedSeconds),
    actualSeconds: typeof row?.actualSeconds === "number" && Number.isFinite(row.actualSeconds)
      ? row.actualSeconds
      : 0,
    varianceSeconds: numberOrNull(row?.varianceSeconds),
    overPlan: row?.overPlan === true ? true : row?.overPlan === false ? false : null,
  }));

  return {
    totals: summary?.totals ?? null,
    rows: shown,
    omittedRows: Math.max(0, rows.length - shown.length),
    note:
      "plannedSeconds and actualSeconds are whole seconds from sessions. A null plannedSeconds means the task has no estimate. Do not add these seconds to the work-log totals.",
  };
}

/**
 * One instant as ISO, or null when it cannot be read.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function instantIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * The start of the local day after `value`.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function exclusiveNextLocalDayIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const next = new Date(date.getTime());
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/**
 * Collapses whitespace and trims. A non-string is empty.
 *
 * @param {unknown} value
 * @returns {string}
 */
function collapse(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * A finite number, or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
