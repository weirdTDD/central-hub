// Central Hub — which Grok model answers a chat.
//
// The names are the text models on xAI's model page (docs.x.ai, October 2026).
// Grok 4.7 is the model xAI recommends for chat. Image, video, and voice models
// are not in this list: this chat is text.
//
// The server may set XAI_CHAT_MODEL (or XAI_MODEL) to a newer grok-* name
// without a code change. A model chosen in the app has to be one of the names
// below, so the browser cannot send an arbitrary model string.

/** The model used when nothing else is configured. */
export const DEFAULT_GROK_MODEL = "grok-4.7";

/**
 * Models the app offers in the picker.
 *
 * @type {Array<{id: string, label: string}>}
 */
export const GROK_MODELS = [
  { id: "grok-4.7", label: "Grok 4.7" },
  { id: "grok-4.6", label: "Grok 4.6" },
  { id: "grok-4.5", label: "Grok 4.5" },
  { id: "grok-4.3", label: "Grok 4.3" },
  { id: "grok-4", label: "Grok 4" },
];

const MODEL_IDS = new Set(GROK_MODELS.map((model) => model.id));

/** A grok model name, including one xAI adds after this list was written. */
const MODEL_NAME = /^grok-[A-Za-z0-9._-]{1,64}$/;

/**
 * True when the string is a plausible Grok model name.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isGrokModelName(value) {
  return typeof value === "string" && MODEL_NAME.test(value.trim());
}

/**
 * True when the app's picker offers this model.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isListedGrokModel(value) {
  return typeof value === "string" && MODEL_IDS.has(value);
}

/**
 * The model a chat request will use.
 *
 * A request from the app must name a listed model. An empty request uses the
 * server's configured model when that name is a grok model, and Grok 4.7
 * otherwise. The server name is not limited to the picker list, so a secret
 * can point at a newer model before the picker knows it.
 *
 * @param {unknown} requested the model the app asked for, or empty
 * @param {unknown} configured the XAI_CHAT_MODEL / XAI_MODEL value
 * @returns {{ok: true, model: string, error: null}|{ok: false, model: null, error: string}}
 */
export function resolveGrokModel(requested, configured) {
  const asked = typeof requested === "string" ? requested.trim() : "";
  if (asked) {
    if (!isListedGrokModel(asked)) {
      return {
        ok: false,
        model: null,
        error: `"${asked}" is not a model this app can ask for.`,
      };
    }
    return { ok: true, model: asked, error: null };
  }

  const fromServer = typeof configured === "string" ? configured.trim() : "";
  if (fromServer) {
    if (!isGrokModelName(fromServer)) {
      return {
        ok: false,
        model: null,
        error: "XAI_CHAT_MODEL is not a grok model name.",
      };
    }
    return { ok: true, model: fromServer, error: null };
  }

  return { ok: true, model: DEFAULT_GROK_MODEL, error: null };
}
