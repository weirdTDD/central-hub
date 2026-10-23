// Sentral Hub — the ai-analytics Edge Function.
//
// This function is the ONLY place that talks to an external AI provider, and it
// exists for three reasons:
//
//   1. THE KEY STAYS HERE. The xAI API key is a paid credential. If the browser
//      called xAI directly the key would have to be a `VITE_` variable, and every
//      `VITE_` variable is inlined into the public JavaScript bundle. The key
//      lives in the function's environment (a Supabase secret) and never reaches
//      the client.
//
//   2. THE DATA IS CHOSEN HERE. The client sends IDS, not content. This function
//      resolves those ids against the AUTHENTICATED user, builds the evidence
//      package with the same minimisation rules the app uses
//      (src/features/ai/evidence.js), and only then calls the provider. A
//      client cannot ask for somebody else's records, and cannot smuggle extra
//      data into the request.
//
//   3. THE CALL IS TRACEABLE. Every call writes an `ai_runs` row: which
//      capability was asked, which model answered, a digest of the evidence that
//      was sent, and the answer itself. That is the traceability MASTER_SPEC 7G
//      requires.
//
// Configure it with:
//   supabase secrets set XAI_API_KEY=<your-xai-key>
//
// It is OPTIONAL: the app works with this function absent, using the on-device
// provider.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildEvidence } from "../../../src/features/ai/evidence.js";
import { validateAiResult } from "../../../src/features/ai/contract.js";
import { compactPlan, prepareAskRequest } from "../../../src/features/ai/ask.js";
import { summarizePlannedVsActual } from "../../../src/features/tracking/plannedVsActual.js";
import { stableHash } from "../../../src/lib/stableId.js";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = "grok-4";
const MAX_OUTPUT_TOKENS = 1200;

/**
 * The browser calls this function from the app's origin. Without these
 * headers the preflight fails and the client reports that the function
 * could not be reached, even when the function is deployed.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** The kinds this function serves. */
const KINDS = ["day_summary", "classify_activity", "priorities", "ask"];

/**
 * The instruction sent to the model for each capability.
 *
 * The prompts ask for JSON and forbid inventing records, because the spec says
 * an AI must not invent records. The answer is validated against the contract
 * afterwards, so a model that ignores this is rejected rather than shown.
 */
const PROMPTS = {
  day_summary: `You are summarising a single person's own work records.
Return ONLY a JSON object: {"summary": string, "highlights": string[]}.
The summary describes what the records show. Do not judge the person, do not
equate time spent with achievement, and do not state anything the records do not
contain.`,
  classify_activity: `You are classifying a person's own activity records against
their own task list.
Return ONLY a JSON object: {"proposals": [{"observationId": string,
"taskId": string|null, "label": string|null, "confidence": number, "reason":
string}]}.
Only propose a task that appears in the provided task list. Set confidence
between 0 and 1. If no task fits, return an empty proposals array. Do not invent
task ids.`,
  priorities: `You are ordering a person's own open tasks.
Return ONLY a JSON object: {"priorities": [{"taskId": string, "reason": string,
"confidence": number}]}.
Only include tasks from the provided list. Order them most to least worth
attention. Do not invent task ids.`,
  ask: `You answer one person's questions about their own work records.
Return ONLY a JSON object: {"answer": string}.
The evidence and the plan are the only source of numbers and titles. The
history is the earlier conversation; it is not a source of records.
plannedSeconds and actualSeconds are whole seconds from sessions. A null
plannedSeconds means that task has no estimate. Do not add session seconds to
the work-log seconds.
Do not invent sessions, tasks, hours, or ids. Do not claim you changed any
record. If the records do not contain the answer, say what is missing.
Do not equate time spent with achievement or mastery.`,
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // Only POST is served: this function causes a paid, outbound call.
  if (request.method !== "POST") {
    return json({ ok: false, error: "Only POST is accepted." }, 405);
  }

  const apiKey = Deno.env.get("XAI_API_KEY");
  if (!apiKey) {
    return json(
      {
        ok: false,
        error:
          "The AI provider is not configured. Set the XAI_API_KEY secret on the function.",
      },
      503
    );
  }

  // The caller must be signed in. The function reads the caller's own rows, so
  // an anonymous call has nothing to read.
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization) {
    return json({ ok: false, error: "You must be signed in." }, 401);
  }

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
  if (userError || !user) {
    return json({ ok: false, error: "You must be signed in." }, 401);
  }

  let body: {
    kind?: string;
    observationIds?: string[];
    from?: string | null;
    to?: string | null;
    question?: string;
    history?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "The request body must be JSON." }, 400);
  }

  const kind = body?.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind)) {
    return json({ ok: false, error: `"${kind}" is not a known AI capability.` }, 400);
  }

  let question: string | null = null;
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (kind === "ask") {
    const prepared = prepareAskRequest(body);
    if (!prepared.ok) {
      return json({ ok: false, error: prepared.error }, 400);
    }
    question = prepared.question;
    history = prepared.history;
  }

  const includeWindowTitles = await readWindowTitleOptIn(supabase, user.id);
  const from = body.from ?? null;
  const to = body.to ?? null;

  let evidence;
  let plan = null;
  try {
    evidence = await buildEvidenceFor(supabase, {
      kind,
      userId: user.id,
      observationIds: body.observationIds,
      from,
      to,
      includeWindowTitles,
    });
    if (kind === "ask") {
      plan = await buildPlanFor(supabase, { userId: user.id, from, to });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }

  const model = Deno.env.get("XAI_MODEL") ?? DEFAULT_MODEL;
  const input = kind === "ask" ? { question, history, evidence, plan } : evidence;
  const inputDigest = kind === "ask"
    ? stableHash(JSON.stringify({ question, history, digest: evidence.digest, plan }))
    : evidence.digest;
  const runId = await startRun(supabase, {
    userId: user.id,
    kind,
    provider: "xai",
    model,
    inputDigest,
    input,
  });

  let parsed: unknown;
  try {
    const raw = await callProvider({ apiKey, model, kind, evidence, question, history, plan });
    parsed = parseJson(raw);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    await finishRun(supabase, runId, { status: "error", error: message });
    return json({ ok: false, error: message }, 502);
  }

  const validation = validateAiResult(kind, parsed);
  if (!validation.ok) {
    const message = `The answer did not satisfy the contract: ${validation.errors.join(" ")}`;
    await finishRun(supabase, runId, { status: "error", error: message });
    return json({ ok: false, error: message }, 502);
  }

  await finishRun(supabase, runId, { status: "success", output: validation.value });

  return json({
    ok: true,
    kind,
    provider: "xai",
    model,
    runId,
    result: validation.value,
    excluded: evidence.excluded,
  });
});

/**
 * Builds the evidence package from the CALLER's own rows.
 *
 * The ids the client sent are filtered by `user_id`, so a client that asks for
 * somebody else's observation simply gets nothing for it.
 */
async function buildEvidenceFor(supabase, options) {
  const { kind, userId, observationIds, from, to, includeWindowTitles } = options;

  const [logs, tasks, observations] = await Promise.all([
    supabase
      .from("work_logs")
      .select("id, title, notes, log_date, duration_seconds, display_name")
      .eq("user_id", userId)
      .limit(500),
    supabase
      .from("tasks")
      .select("id, title, description, status, priority, due_date, estimated_duration_seconds")
      .eq("user_id", userId)
      .limit(500),
    supabase
      .from("observations")
      .select("id, source, occurred_at, duration_seconds, application, window_title, is_idle")
      .eq("user_id", userId)
      .limit(500),
  ]);

  const logRows = rowsOf(logs, "work logs");
  const taskRows = rowsOf(tasks, "tasks");
  let scopedObservations = rowsOf(observations, "activity");
  if (Array.isArray(observationIds) && observationIds.length > 0) {
    const wanted = new Set(observationIds);
    scopedObservations = scopedObservations.filter((row) => wanted.has(row.id));
  }

  return buildEvidence({
    logs: logRows,
    tasks: taskRows,
    observations: scopedObservations,
    from,
    to,
    includeWindowTitles,
  });
}

/**
 * The planned-versus-actual totals for a question.
 *
 * Sessions are a different stream from work logs. The summary is computed
 * here, from the caller's own sessions and corrections, so the model quotes
 * these figures instead of inventing a comparison.
 */
async function buildPlanFor(supabase, { userId, from, to }) {
  let sessionsQuery = supabase
    .from("sessions")
    .select("id, started_at, ended_at, duration_seconds, task_id")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(500);
  if (typeof from === "string" && from !== "") sessionsQuery = sessionsQuery.gte("started_at", from);
  if (typeof to === "string" && to !== "") sessionsQuery = sessionsQuery.lt("started_at", to);

  const [sessions, tasks, corrections] = await Promise.all([
    sessionsQuery,
    supabase
      .from("tasks")
      .select("id, title, status, estimated_duration_seconds")
      .eq("user_id", userId)
      .limit(500),
    supabase
      .from("session_corrections")
      .select("session_id, corrected_started_at, corrected_ended_at, corrected_duration_seconds, reason, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  const summary = summarizePlannedVsActual({
    sessions: rowsOf(sessions, "sessions"),
    tasks: rowsOf(tasks, "tasks"),
    corrections: rowsOf(corrections, "session corrections"),
  });
  return compactPlan(summary);
}

/**
 * The rows of a query, or a thrown error that names the table.
 *
 * A failed read must not look like an empty set: an empty set would be sent
 * to the model as if the person had no records.
 */
function rowsOf(result, label) {
  if (result?.error) {
    throw new Error(`Your ${label} could not be read: ${result.error.message}`);
  }
  return result?.data ?? [];
}

/**
 * True when the user has opted in to including window titles.
 *
 * The default is false, so a user who never touched the setting is never asked
 * to consent, and their window titles do not leave the database.
 */
async function readWindowTitleOptIn(supabase, userId) {
  const { data } = await supabase
    .from("ai_preferences")
    .select("include_window_titles")
    .eq("user_id", userId)
    .maybeSingle();

  return data?.include_window_titles === true;
}

/**
 * Calls the provider and returns the raw text of its answer.
 */
async function callProvider({ apiKey, model, kind, evidence, question = null, history = [], plan = null }) {
  const evidenceBody = {
    range: evidence.range,
    totals: evidence.totals,
    perDay: evidence.perDay,
    tasks: evidence.tasks,
    activity: evidence.activity,
  };
  const userContent = kind === "ask"
    ? { question, history, plan, evidence: evidenceBody }
    : { evidence: evidenceBody };

  const response = await fetch(XAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PROMPTS[kind] },
        { role: "user", content: JSON.stringify(userContent) },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `The provider refused the request (${response.status}): ${redactSecrets(text).slice(0, 300)}`
    );
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("The provider returned an empty answer.");
  }
  return content;
}

/**
 * Removes a credential if a provider error echoes one back.
 *
 * The status text is shown to the signed-in user and stored on the run.
 * A key that appears in it would then leave the function.
 */
function redactSecrets(text) {
  return String(text)
    .replace(/xai-[A-Za-z0-9_-]+/g, "xai-…")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-…");
}

/**
 * Parses a JSON answer, tolerating a model that wrapped it in a code fence.
 */
function parseJson(raw) {
  const text = raw.trim();
  const unfenced = text.startsWith("```")
    ? text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim()
    : text;
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new Error("The provider did not answer with JSON.");
  }
}

/**
 * Writes the 'running' run record.
 */
async function startRun(supabase, { userId, kind, provider, model, inputDigest, input }) {
  const { data, error } = await supabase
    .from("ai_runs")
    .insert({
      user_id: userId,
      kind,
      provider,
      model,
      input_digest: inputDigest,
      input,
      status: "running",
    })
    .select("id")
    .single();

  if (error) throw new Error(`The run could not be recorded: ${error.message}`);
  return data.id as string;
}

/**
 * Closes the run record.
 */
async function finishRun(supabase, runId, { status, output = null, error = null }) {
  const { error: updateError } = await supabase
    .from("ai_runs")
    .update({
      status,
      output,
      error,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (updateError) {
    // A failure to record the failure must not hide the original reason.
    console.error("ai_runs update failed", updateError.message);
  }
}

/**
 * A JSON response with the right status code.
 */
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
