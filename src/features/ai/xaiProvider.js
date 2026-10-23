// Sentral Hub — the xAI (Grok) provider.
//
// Serves MASTER_SPEC Section 7G and Section 8.
//
// WHY THE CALL GOES THROUGH A SERVER: the xAI API key is a paid credential. If
// the browser called xAI directly, the key would have to be a `VITE_` variable,
// and every `VITE_` variable is inlined into the public JavaScript bundle — so
// the key would be readable by anyone who opens the app. Section 8 forbids
// exposing server secrets to client code, so the key never reaches the browser:
// the app calls a Supabase Edge Function, and the function holds the key.
//
// WHY THE CLIENT SENDS IDS, NOT DATA: the function rebuilds the evidence
// package server-side from the caller's OWN rows, and it applies the same
// minimisation rules (src/features/ai/evidence.js). The client therefore never
// transmits the content it wants analysed — it asks for an analysis of a set of
// record ids — and it cannot ask for somebody else's records, because the
// function resolves them against the authenticated user.
//
// This module is deliberately free of React so it can be tested without a DOM.

import { supabase, isSupabaseConfigured } from "../../lib/supabase.js";
import { validateAiResult } from "./contract.js";

/** The provider's id. */
export const PROVIDER_ID = "xai";

/** The name of the Edge Function that holds the xAI key. */
export const FUNCTION_NAME = "ai-analytics";

/**
 * The xAI provider.
 *
 * @type {import("./contract.js").AiProvider}
 */
export const xaiProvider = {
  id: PROVIDER_ID,
  label: "Grok (xAI)",
  summary:
    "Sends a minimised summary of your own records to xAI's Grok model and returns a structured answer. Your raw rows never leave the database.",
  available: () => isSupabaseConfigured,

  /**
   * Asks the Edge Function for an analysis.
   *
   * @param {{kind: string, request: object}} input
   * @returns {Promise<{kind: string, provider: string, model: string, result: object, runId: string|null}>}
   * @throws {Error} when the function is not deployed, the call fails, or the
   *   answer does not satisfy the contract
   */
  async analyse({ kind, request }) {
    if (!supabase) {
      throw new Error(
        "Supabase is not configured, so the AI provider cannot be reached."
      );
    }

    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { kind, ...(request ?? {}) },
    });

    if (error) {
      throw new Error(await readFunctionError(error));
    }

    if (!data || data.ok !== true) {
      throw new Error(
        data?.error ||
          "The AI function did not return a result. It may not be deployed yet, or the provider may be unavailable."
      );
    }

    // The function's own answer is validated there; it is validated again here
    // because an answer that crosses a process boundary is untrusted input.
    const validation = validateAiResult(kind, data.result);
    if (!validation.ok) {
      throw new Error(
        `The AI answer did not satisfy the contract: ${validation.errors.join(" ")}`
      );
    }

    return {
      kind,
      provider: data.provider ?? PROVIDER_ID,
      model: data.model ?? "unknown",
      result: validation.value,
      runId: typeof data.runId === "string" ? data.runId : null,
      excluded: Array.isArray(data.excluded) ? data.excluded : [],
    };
  },
};

/**
 * The message to show when the function refuses the call.
 *
 * A non-2xx response from `functions.invoke` hides the function's own JSON
 * error behind a generic status line. The JSON is what says the key is
 * missing or the question was refused, so that text is the one the chat shows.
 *
 * @param {{message?: string, context?: {json?: () => Promise<object>}}} error
 * @returns {Promise<string>}
 */
async function readFunctionError(error) {
  const context = error?.context;
  if (context && typeof context.json === "function") {
    try {
      const body = await context.json();
      if (typeof body?.error === "string" && body.error.trim() !== "") {
        return body.error.trim();
      }
    } catch {
      // The body was not JSON. The status text below is the fallback.
    }
  }
  if (typeof error?.message === "string" && error.message.trim() !== "") {
    const message = error.message.trim();
    if (/failed to send a request to the edge function/i.test(message)) {
      return "Grok is not reachable yet. Deploy the ai-analytics function and set the XAI_API_KEY secret on it.";
    }
    return message;
  }
  return "The AI function could not be reached. It may not be deployed yet.";
}
