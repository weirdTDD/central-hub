// Central Hub — the AI contract.
//
// Serves MASTER_SPEC Section 7G ("Future AI assistance"):
//   - the app MUST fully work with AI disabled or unconfigured;
//   - AI must not invent records, silently change important task states,
//     bypass permissions, or execute consequential actions without approval;
//   - every AI-generated action must be traceable (inputs, model, output,
//     approval), reviewable and reversible where possible;
//   - minimise and disclose what user data is sent to any external provider.
//
// The contract is deliberately PURE (no React, no network, no browser APIs) so
// the rules can be verified with plain Node assertions — see
// scripts/verify-ai.mjs. The same module is imported by the browser bundle and
// by the Supabase Edge Function, so both sides agree on what a valid answer is.

/**
 * What an AI provider may be asked to do.
 *
 * These are the capabilities MASTER_SPEC 7G names: summarise the day, classify
 * ambiguous activity, and suggest priorities. `ask` is a question about those
 * same records. Nothing else may be requested — an unknown kind is refused
 * rather than sent to a model.
 */
export const AI_KINDS = ["day_summary", "classify_activity", "priorities", "ask"];

/**
 * The one-shot analyses on the reports panel.
 *
 * A question is a conversation, so it is not one of these buttons.
 */
export const ANALYSIS_KINDS = ["day_summary", "classify_activity", "priorities"];

/** The states an AI run can end in. A run is its own record. */
export const AI_RUN_STATUSES = ["running", "success", "error"];

/**
 * The states a classification proposal can be in.
 *
 * A proposal starts as `pending`. It is NEVER applied to a task automatically:
 * `approved` means the user accepted it, `rejected` means they did not. A
 * proposal that is neither has not been decided.
 */
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"];

/** The provider ids the app knows. */
export const PROVIDER_IDS = ["local", "xai"];

/**
 * The provider used when nothing else is configured.
 *
 * It is always available and needs no key, no network and no third party, so
 * the app never depends on an AI provider for ordinary functionality.
 */
export const DEFAULT_PROVIDER_ID = "local";

/**
 * Below this confidence a classification is not worth showing as a proposal.
 *
 * A low-confidence guess is noise, and noise in a review list is worse than a
 * short list: it trains the user to ignore the panel.
 *
 * The threshold matches the one the tracking domain already uses for a
 * rule-based or inferred attribution (ATTRIBUTION_SUGGESTION_THRESHOLD in
 * src/features/tracking/sessionUtils.js), so a suggestion is surfaced in the
 * same places and at the same confidence.
 */
export const MIN_ACCEPTABLE_CONFIDENCE = 0.5;

/**
 * The confidence bands, highest first.
 *
 * The bands are shown to the user next to every proposal, because a bare
 * number is not a meaningful thing to agree or disagree with.
 */
export const CONFIDENCE_BANDS = [
  { id: "high", label: "High confidence", min: 0.8 },
  { id: "medium", label: "Medium confidence", min: 0.5 },
  { id: "low", label: "Low confidence", min: 0 },
];

/**
 * True when the kind is one the contract knows.
 *
 * @param {unknown} kind
 * @returns {boolean}
 */
export function isAiKind(kind) {
  return typeof kind === "string" && AI_KINDS.includes(kind);
}

/**
 * Clamps a confidence into 0..1.
 *
 * A provider that returns 1.4 or -0.2 is not trusted, and a negative or
 * out-of-range confidence would sort a proposal above a certain one.
 *
 * @param {unknown} value
 * @returns {number} a number in 0..1
 */
export function normaliseConfidence(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

/**
 * The band a confidence falls into.
 *
 * @param {unknown} value
 * @returns {{id: string, label: string, min: number}}
 */
export function confidenceBand(value) {
  const confidence = normaliseConfidence(value);
  return (
    CONFIDENCE_BANDS.find((band) => confidence >= band.min) ??
    CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1]
  );
}

/**
 * True when a confidence is high enough to be worth reviewing.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isWorthReviewing(value) {
  return normaliseConfidence(value) >= MIN_ACCEPTABLE_CONFIDENCE;
}

/**
 * Validates the structured answer a provider returned.
 *
 * WHY this exists: a model's output is UNTRUSTED input. It can be malformed,
 * it can be missing fields, and it can contain a confidence above 1. A
 * provider that answers with something else is treated as a failed run, and
 * the raw text is never handed to the UI as if it were a result.
 *
 * @param {string} kind the kind that was requested
 * @param {unknown} result the provider's answer
 * @returns {{ok: boolean, errors: string[], value: object|null}} the normalised value
 */
export function validateAiResult(kind, result) {
  const errors = [];

  if (!isAiKind(kind)) {
    return {
      ok: false,
      errors: [`"${kind}" is not a known AI capability.`],
      value: null,
    };
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {
      ok: false,
      errors: ["The provider did not return an object."],
      value: null,
    };
  }

  if (kind === "classify_activity") {
    const proposals = result.proposals;
    if (!Array.isArray(proposals)) {
      errors.push("`proposals` must be an array.");
    } else {
      proposals.forEach((proposal, index) => {
        if (!proposal || typeof proposal !== "object") {
          errors.push(`proposals[${index}] is not an object.`);
          return;
        }
        if (typeof proposal.observationId !== "string" || proposal.observationId === "") {
          errors.push(`proposals[${index}].observationId is missing.`);
        }
        const hasTask = typeof proposal.taskId === "string" && proposal.taskId !== "";
        const hasLabel = typeof proposal.label === "string" && proposal.label !== "";
        if (!hasTask && !hasLabel) {
          errors.push(`proposals[${index}] names neither a task nor a label.`);
        }
        if (!("confidence" in proposal)) {
          errors.push(`proposals[${index}].confidence is missing.`);
        }
      });
    }
  }

  if (kind === "day_summary") {
    if (typeof result.summary !== "string" || result.summary.trim() === "") {
      errors.push("`summary` must be a non-empty string.");
    }
  }

  if (kind === "priorities") {
    if (!Array.isArray(result.priorities)) {
      errors.push("`priorities` must be an array.");
    } else {
      result.priorities.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
          errors.push(`priorities[${index}] is not an object.`);
          return;
        }
        if (typeof entry.taskId !== "string" || entry.taskId === "") {
          errors.push(`priorities[${index}].taskId is missing.`);
        }
      });
    }
  }

  if (kind === "ask") {
    if (typeof result.answer !== "string" || result.answer.trim() === "") {
      errors.push("`answer` must be a non-empty string.");
    }
  }

  if (errors.length > 0) return { ok: false, errors, value: null };

  return { ok: true, errors: [], value: normaliseResult(kind, result) };
}

/**
 * Normalises a valid result: clamps every confidence, drops empty entries.
 *
 * @param {string} kind
 * @param {object} result
 * @returns {object}
 */
function normaliseResult(kind, result) {
  if (kind === "classify_activity") {
    return {
      proposals: result.proposals.map((proposal) => ({
        observationId: proposal.observationId,
        taskId: typeof proposal.taskId === "string" && proposal.taskId !== "" ? proposal.taskId : null,
        label: typeof proposal.label === "string" && proposal.label !== "" ? proposal.label : null,
        confidence: normaliseConfidence(proposal.confidence),
        reason: typeof proposal.reason === "string" ? proposal.reason : null,
      })),
    };
  }

  if (kind === "day_summary") {
    return {
      summary: result.summary.trim(),
      highlights: Array.isArray(result.highlights)
        ? result.highlights.filter((item) => typeof item === "string" && item.trim() !== "")
        : [],
    };
  }

  if (kind === "ask") {
    return { answer: result.answer.trim() };
  }

  return {
    priorities: result.priorities.map((entry) => ({
      taskId: entry.taskId,
      reason: typeof entry.reason === "string" ? entry.reason : null,
      confidence: normaliseConfidence(entry.confidence),
    })),
  };
}
