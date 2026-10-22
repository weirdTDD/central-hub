import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { confidenceBand } from "./contract.js";
import { decideClassificationProposal } from "../../lib/ai.js";
import { findSessionByObservationId, updateSessionAttribution } from "../../lib/tracking.js";

/**
 * The review step for classification proposals.
 *
 * Serves MASTER_SPEC Section 7G: "AI must not ... silently change important
 * task states". Nothing here happens until the user presses a button:
 *
 *   - APPROVE attributes the session that contains the observation to the
 *     proposed task, and records HOW it was attributed (`rule` for the
 *     on-device provider, `inferred` for a model), so the attribution is shown
 *     as a suggestion rather than as a confirmed fact;
 *   - REJECT changes nothing but the proposal's own state.
 *
 * A proposal whose observation belongs to no session cannot be applied, and
 * says so instead of silently doing nothing.
 */
export default function ClassificationReview({ proposals = [], onDecided }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  if (!proposals.length) return null;

  const decide = async (proposal, status) => {
    setBusyId(proposal.id);
    setError(null);
    setNote(null);

    try {
      if (status === "approved") {
        const session = await findSessionByObservationId(proposal.observation_id);
        if (!session) {
          throw new Error(
            "This activity does not belong to a session, so there is nothing to attribute yet."
          );
        }

        await updateSessionAttribution(session.id, {
          taskId: proposal.proposed_task_id,
          // The attribution records HOW it was made: a rule-based suggestion and
          // a model's suggestion are different kinds of evidence.
          attributionSource: proposal.provider === "local" ? "rule" : "inferred",
          attributionConfidence: Number(proposal.confidence),
        });
      }

      await decideClassificationProposal(proposal.id, status);
      setNote(
        status === "approved"
          ? "Attributed. The attribution is recorded as a suggestion, not a confirmed fact."
          : "Rejected. Nothing was changed."
      );
      await onDecided?.();
    } catch (caught) {
      setError(caught?.message || "The proposal could not be decided.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-foreground">
        Proposed attributions
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        These are suggestions. Nothing has been applied to your tasks until you
        accept one.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="mt-3 text-sm text-muted-foreground">{note}</p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {proposals.map((proposal) => {
          const band = confidenceBand(proposal.confidence);
          const busy = busyId === proposal.id;
          return (
            <li
              key={proposal.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {proposal.proposed_label ?? "Unnamed task"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {band.label}
                  {proposal.reason ? ` · ${proposal.reason}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(proposal, "approved")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  Accept
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => decide(proposal, "rejected")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
