// Sentral Hub — the on-device provider.
//
// Serves MASTER_SPEC Section 7G: "the app MUST fully work with AI disabled or
// unconfigured". This provider is always available: it needs no key, no network
// and no third party, and it computes its answers from the evidence package
// with plain rules.
//
// It is NOT a worse stand-in for a model — it is a DIFFERENT KIND of answer.
// It reports what the records show, with the evidence attached, and it never
// claims to know something the records do not say. Where a model would
// speculate, this provider says nothing.
//
// This module is deliberately PURE so its rules can be verified with plain Node
// assertions — see scripts/verify-ai.mjs.

import {
  MIN_ACCEPTABLE_CONFIDENCE,
  normaliseConfidence,
} from "./contract.js";

/** Words that carry no meaning when matching an activity to a task. */
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "of", "in", "on", "for", "with", "at", "by",
  "from", "is", "are", "was", "were", "be", "been", "it", "its", "as", "or",
  "this", "that", "these", "those", "my", "our", "your", "their",
]);

/** The provider's id. */
export const PROVIDER_ID = "local";

/**
 * The on-device provider.
 *
 * @type {import("./contract.js").AiProvider}
 */
export const localProvider = {
  id: PROVIDER_ID,
  label: "On-device (no AI)",
  summary:
    "Computes the analysis from your own records with plain rules. Nothing leaves this device and no model is involved.",
  available: () => true,

  /**
   * Answers a request from the evidence package.
   *
   * @param {{kind: string, evidence: object}} request
   * @returns {Promise<{kind: string, provider: string, model: string, result: object}>}
   */
  async analyse({ kind, evidence, question }) {
    const package_ = evidence ?? {};
    if (kind === "ask") {
      return {
        kind,
        provider: PROVIDER_ID,
        model: "on-device-rules",
        result: answerQuestion(package_, question),
      };
    }
    if (kind === "classify_activity") {
      return {
        kind,
        provider: PROVIDER_ID,
        model: "on-device-rules",
        result: classifyActivity(package_),
      };
    }
    if (kind === "day_summary") {
      return {
        kind,
        provider: PROVIDER_ID,
        model: "on-device-rules",
        result: summariseDay(package_),
      };
    }
    if (kind === "priorities") {
      return {
        kind,
        provider: PROVIDER_ID,
        model: "on-device-rules",
        result: rankPriorities(package_),
      };
    }
    throw new Error(`"${kind}" is not a known AI capability.`);
  },
};

/**
 * Answers a question from the totals already in the package.
 *
 * The reply quotes those totals and names tasks whose titles share a word
 * with the question. It does not estimate a duration the records omit, and
 * it does not claim a model was involved.
 *
 * @param {object} evidence
 * @param {unknown} question
 * @returns {{answer: string}}
 */
export function answerQuestion(evidence, question) {
  const totals = evidence?.totals ?? {};
  const tasks = Array.isArray(evidence?.tasks) ? evidence.tasks : [];
  const asked = typeof question === "string" ? question.toLowerCase() : "";
  const askedWords = tokenise(asked);
  const named = tasks
    .filter((task) => {
      const words = tokenise(task?.title);
      return [...words].some((word) => askedWords.has(word));
    })
    .map((task) => task.title)
    .filter((title) => typeof title === "string" && title !== "")
    .slice(0, 5);

  const recorded = totals.recordedSeconds ?? 0;
  const entries = totals.logEntries ?? 0;
  const parts = [
    `Your work logs in this package show ${entries} entries and ${recorded} recorded seconds.`,
  ];
  if (named.length > 0) {
    parts.push(`Tasks named in the question: ${named.join(", ")}.`);
  } else if (tasks.length > 0) {
    parts.push(`${tasks.length} tasks are in the package. None of their titles share a word with the question.`);
  } else {
    parts.push("No task titles are in this package.");
  }
  const plan = evidence?.plan?.totals;
  if (plan && typeof plan.plannedSeconds === "number" && typeof plan.actualSeconds === "number") {
    parts.push(
      `Planned versus actual, from sessions only: ${plan.plannedSeconds} planned seconds and ${plan.actualSeconds} recorded seconds.`
    );
  }
  parts.push("This reply was computed on this device. It has not changed any task or session.");
  return { answer: parts.join(" ") };
}

/**
 * Matches activity to tasks by comparing the words in the task title with the
 * words in the activity.
 *
 * WHY words and not a model: the match is explainable. Every proposal says
 * which words matched, so the user can agree or disagree with the REASON and
 * not just with a number.
 *
 * @param {object} evidence
 * @returns {{proposals: Array<object>}}
 */
export function classifyActivity(evidence) {
  const tasks = Array.isArray(evidence?.tasks) ? evidence.tasks : [];
  const activity = Array.isArray(evidence?.activity) ? evidence.activity : [];

  const proposals = [];

  for (const entry of activity) {
    if (!entry?.id) continue;

    const activityTokens = tokenise(
      [entry.application, entry.windowTitle].filter(Boolean).join(" ")
    );
    if (activityTokens.size === 0) continue;

    let best = null;

    for (const task of tasks) {
      if (!task?.id) continue;
      const taskTokens = tokenise(task.title);
      if (taskTokens.size === 0) continue;

      const matched = [...taskTokens].filter((token) => activityTokens.has(token));
      if (matched.length === 0) continue;

      // The confidence is the share of the TASK's words that the activity
      // mentions. A task whose title is three words and whose activity
      // mentions two of them is a better match than one where a single
      // common word matched a long title.
      const confidence = normaliseConfidence(matched.length / taskTokens.size);

      if (!best || confidence > best.confidence) {
        best = {
          observationId: entry.id,
          taskId: task.id,
          label: task.title || null,
          confidence,
          reason: `Matched on: ${matched.join(", ")}.`,
        };
      }
    }

    if (best && best.confidence >= MIN_ACCEPTABLE_CONFIDENCE) {
      proposals.push(best);
    }
  }

  proposals.sort((a, b) => b.confidence - a.confidence);
  return { proposals };
}

/**
 * Describes the recorded range in plain sentences.
 *
 * Every sentence is a statement about the records, not a judgement about the
 * person: the app does not equate hours spent with achievement.
 *
 * @param {object} evidence
 * @returns {{summary: string, highlights: string[]}}
 */
export function summariseDay(evidence) {
  const totals = evidence?.totals ?? {};
  const perDay = Array.isArray(evidence?.perDay) ? evidence.perDay : [];

  const entries = numberOrZero(totals.logEntries);
  const seconds = numberOrZero(totals.recordedSeconds);
  const days = numberOrZero(totals.days);

  const parts = [];
  if (entries === 0) {
    parts.push("No work log entries were recorded in this range.");
  } else {
    parts.push(
      `${entries} work log ${entries === 1 ? "entry" : "entries"} were recorded across ${days} ${days === 1 ? "day" : "days"}.`
    );
  }

  if (seconds > 0) {
    parts.push(`${formatDuration(seconds)} of time was recorded with a duration.`);
  } else if (entries > 0) {
    parts.push("None of them carry a recorded duration.");
  }

  const highlights = [];
  const busiest = [...perDay].sort((a, b) => b.seconds - a.seconds)[0];
  if (busiest && busiest.seconds > 0) {
    highlights.push(
      `The most recorded time in a single day was ${formatDuration(busiest.seconds)} on ${busiest.date}.`
    );
  }
  const idle = (evidence?.activity ?? []).filter((entry) => entry?.isIdle).length;
  if (idle > 0) {
    highlights.push(`${idle} activity ${idle === 1 ? "entry was" : "entries were"} recorded as idle.`);
  }

  return { summary: parts.join(" "), highlights };
}

/**
 * Orders the tasks that are worth attention.
 *
 * The order is derived from the records — a task that is overdue, or in
 * progress, or has no recorded time against an estimate — and never from a
 * guess about what the user should care about.
 *
 * @param {object} evidence
 * @returns {{priorities: Array<object>}}
 */
export function rankPriorities(evidence) {
  const tasks = Array.isArray(evidence?.tasks) ? evidence.tasks : [];
  const today = new Date().toISOString().slice(0, 10);

  const priorities = [];

  for (const task of tasks) {
    if (!task?.id) continue;
    if (task.status === "completed" || task.status === "cancelled") continue;

    let score = 0;
    const reasons = [];

    if (task.dueDate && task.dueDate < today) {
      score += 3;
      reasons.push(`Overdue since ${task.dueDate}.`);
    } else if (task.dueDate) {
      score += 1;
      reasons.push(`Due on ${task.dueDate}.`);
    }
    if (task.status === "in_progress") {
      score += 2;
      reasons.push("Already in progress.");
    }
    if (task.status === "blocked") {
      score += 2;
      reasons.push("Blocked, so it needs attention to move.");
    }
    if (task.estimatedSeconds === null) {
      reasons.push("No time estimate has been set.");
    }

    if (score === 0) continue;

    priorities.push({
      taskId: task.id,
      reason: reasons.join(" ") || "Open task.",
      confidence: normaliseConfidence(Math.min(score / 5, 1)),
    });
  }

  priorities.sort((a, b) => b.confidence - a.confidence);
  return { priorities };
}

/**
 * Reduces text to the set of meaningful lowercase words.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenise(text) {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  return new Set(words.filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
}

/**
 * Formats a number of seconds as a readable duration.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(numberOrZero(seconds)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
