import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, CircleCheck, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

import { buildEvidence } from "./evidence.js";
import { resolveProvider, isOnDeviceOnly } from "./provider.js";
import { validateAiResult, confidenceBand, ANALYSIS_KINDS } from "./contract.js";
import {
  completeAiRun,
  insertAiRun,
  insertClassificationProposals,
  listClassificationProposals,
  readAiPreferences,
} from "../../lib/ai.js";
import { listTasks } from "../../lib/tasks.js";
import { listObservations } from "../../lib/tracking.js";
import ClassificationReview from "./ClassificationReview.jsx";

/**
 * The analysis panel.
 *
 * Serves MASTER_SPEC Section 7G. The rules it keeps:
 *   - the analysis is ONLY ever run when the user asks for it, so no analysis
 *     is ever started by a background refresh;
 *   - the panel states which provider answered, so an on-device answer is never
 *     passed off as a model's;
 *   - it states what was withheld, so the user can see the boundary of what
 *     left the device;
 *   - a classification is a PROPOSAL. It is listed for review and is never
 *     applied to a task on its own.
 */
export default function InsightsPanel({ logs = [], from = null, to = null }) {
  const [preferences, setPreferences] = useState({
    provider: "local",
    includeWindowTitles: false,
  });
  const [tasks, setTasks] = useState([]);
  const [observations, setObservations] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const provider = useMemo(
    () => resolveProvider(preferences.provider),
    [preferences.provider]
  );
  const onDeviceOnly = isOnDeviceOnly(preferences.provider);

  const loadProposals = useCallback(async () => {
    try {
      const { rows } = await listClassificationProposals({ status: "pending" });
      setProposals(rows);
    } catch {
      // A failed read leaves the list empty rather than showing a wrong list.
      setProposals([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [prefs, taskPage, observationPage] = await Promise.all([
          readAiPreferences(),
          listTasks(),
          listObservations(),
        ]);
        if (cancelled) return;
        setPreferences(prefs);
        setTasks(taskPage.rows);
        setObservations(observationPage.rows);
      } catch {
        if (!cancelled) setError("The analysis could not load your records.");
      }
      if (!cancelled) loadProposals();
    })();

    return () => {
      cancelled = true;
    };
  }, [loadProposals]);

  const runAnalysis = async (kind) => {
    setRunning(true);
    setError(null);
    setStatus(null);
    setResult(null);

    const evidence = buildEvidence({
      logs,
      tasks,
      observations,
      from,
      to,
      includeWindowTitles: preferences.includeWindowTitles,
    });

    let runId = null;

    try {
      // The on-device provider is answered here; an external provider is asked
      // for the same analysis by the function, which records the run itself.
      if (!onDeviceOnly) {
        const observationIds = evidence.activity.map((entry) => entry.id);
        const answer = await provider.analyse({
          kind,
          request: { observationIds, from, to },
        });
        runId = answer.runId;
        setResult({ kind, value: answer.result });
        setStatus(
          `${answer.provider} · ${answer.model} · ${answer.runId ? `run ${answer.runId.slice(0, 8)}` : "not recorded"}`
        );
      } else {
        runId = await insertAiRun({
          kind,
          provider: provider.id,
          model: "on-device-rules",
          inputDigest: evidence.digest,
          input: evidence,
        });

        const answer = await provider.analyse({ kind, evidence });
        const validation = validateAiResult(kind, answer.result);
        if (!validation.ok) {
          await completeAiRun(runId, {
            status: "error",
            error: validation.errors.join(" "),
          });
          throw new Error(validation.errors.join(" "));
        }

        await completeAiRun(runId, { status: "success", output: validation.value });
        setResult({ kind, value: validation.value });
        setStatus(`${answer.provider} · ${answer.model} · run ${runId.slice(0, 8)}`);

        if (kind === "classify_activity" && validation.value.proposals.length > 0) {
          await insertClassificationProposals(validation.value.proposals, runId);
          await loadProposals();
        }
      }
    } catch (caught) {
      setError(caught?.message || "The analysis could not be completed.");
      // A run that was opened and then failed must be closed as a failure.
      if (runId && onDeviceOnly) {
        try {
          await completeAiRun(runId, {
            status: "error",
            error: caught?.message || "The analysis could not be completed.",
          });
        } catch {
          // The reason is already shown to the user.
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card-mist p-6 shadow-lift">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Analysis</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {onDeviceOnly
              ? "Computed on this device from your own records. Nothing is sent anywhere and no model is involved."
              : `Your minimised records are sent to ${provider.label}. Task titles and notes are included; window titles are only included if you turned them on.`}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          {provider.label}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {ANALYSIS_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={running}
            onClick={() => runAnalysis(kind)}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {running ? (
              <Skeleton className="h-4 w-4" />
            ) : null}
            {KIND_LABELS[kind] ?? kind}
          </button>
        ))}
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}

      {status ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <CircleCheck className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
          {status}
        </p>
      ) : null}

      {result ? <AnalysisResult kind={result.kind} result={result.value} /> : null}

      <ClassificationReview
        proposals={proposals}
        onDecided={loadProposals}
      />
    </section>
  );
}

/** The button label for each capability. */
const KIND_LABELS = {
  day_summary: "Summarise the range",
  classify_activity: "Classify activity",
  priorities: "Suggest priorities",
};

/**
 * Renders the answer.
 *
 * The on-device answer is stated as what the records show. A model's answer is
 * shown as the model's answer — it is never presented as a fact about the user.
 */
function AnalysisResult({ result }) {
  if (!result) return null;

  if (result.summary) {
    return (
      <div className="mt-4 rounded-xl border border-border bg-background p-4">
        <p className="text-sm leading-relaxed text-foreground">{result.summary}</p>
        {result.highlights?.length ? (
          <ul className="mt-3 space-y-1.5">
            {result.highlights.map((highlight) => (
              <li
                key={highlight}
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                {highlight}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (result.proposals?.length) {
    return (
      <p className="mt-4 text-sm text-muted-foreground">
        {result.proposals.length} proposal
        {result.proposals.length === 1 ? " was" : "s were"} found. Review{" "}
        {result.proposals.length === 1 ? "it" : "them"} below — nothing has been
        applied to your tasks.
      </p>
    );
  }

  if (result.priorities?.length) {
    return (
      <ul className="mt-4 space-y-2">
        {result.priorities.map((entry, index) => (
          <li
            key={entry.taskId}
            className="flex items-start gap-3 rounded-xl border border-border bg-background px-3 py-2"
          >
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{entry.reason}</p>
              <p className="text-xs text-muted-foreground">
                {confidenceBand(entry.confidence).label}
              </p>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return null;
}
