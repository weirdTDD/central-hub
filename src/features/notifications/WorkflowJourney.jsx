// A live view of one workflow.
//
// Every node is a stored fact: the definition, the latest run, an approval, a
// notification timestamp, or the planned next occurrence.

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { buildWorkflowJourney } from "./workflowJourneyModel.js";

const PHASES = [
  { id: "start", label: "Start" },
  { id: "live", label: "Live" },
  { id: "wrap", label: "Wrap up" },
];

function formatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StageRail({ phase }) {
  const active = PHASES.findIndex((item) => item.id === phase);

  return (
    <ol className="grid grid-cols-3 gap-3" aria-label="Workflow stage">
      {PHASES.map((item, index) => {
        const done = index < active;
        const current = index === active;
        return (
          <li key={item.id} className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                  done
                    ? "border-progress bg-progress text-white"
                    : current
                      ? "border-primary bg-primary text-primary-foreground motion-safe:animate-pulse"
                      : "border-border bg-card text-muted-foreground"
                }`}
                aria-hidden="true"
              >
                {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
              </span>
              {index < PHASES.length - 1 ? (
                <span
                  className={`h-0.5 flex-1 rounded-full ${
                    index < active ? "bg-progress" : "bg-border"
                  }`}
                />
              ) : null}
            </div>
            <p
              className={`mt-2 text-xs font-semibold ${
                current ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              {item.label}
              {current ? <span className="sr-only">, current stage</span> : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function JourneyTimeline({ steps }) {
  return (
    <ol className="mt-4 space-y-0" aria-label="Workflow journey">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const current = step.state === "current";
        const failed = step.tone === "failed";
        return (
          <li key={step.key} className="grid grid-cols-[1.25rem_1fr] gap-3" aria-current={current ? "step" : undefined}>
            <div className="flex flex-col items-center">
              <span
                className={`mt-3 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                  failed
                    ? "border-destructive bg-destructive"
                    : step.state === "done"
                      ? "border-progress bg-progress"
                      : current
                        ? "border-primary bg-primary motion-safe:animate-pulse"
                        : "border-border bg-card"
                }`}
              />
              {last ? null : (
                <span
                  className={`w-0.5 flex-1 ${
                    step.state === "done" ? "bg-progress" : "bg-border"
                  }`}
                />
              )}
            </div>
            <article
              className={`mb-3 rounded-2xl border px-4 py-3 ${
                current
                  ? "border-primary/40 bg-primary/5"
                  : step.state === "upcoming"
                    ? "border-dashed border-border bg-transparent"
                    : "border-border bg-card"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="text-sm font-semibold text-foreground">{step.title}</h4>
                {current ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    Current
                  </span>
                ) : null}
                {step.state === "upcoming" ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    Upcoming
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
              {formatTimestamp(step.time) ? (
                <p className="mt-1 text-xs text-muted-foreground">{formatTimestamp(step.time)}</p>
              ) : null}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

export default function WorkflowJourney({
  workflows,
  runs,
  notifications,
  approvals,
  onToggle,
}) {
  const [selectedId, setSelectedId] = useState(null);
  const selected =
    workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0] ?? null;

  const journey = useMemo(() => {
    if (!selected) return null;
    return buildWorkflowJourney({
      workflow: selected,
      runs,
      notifications,
      approvals,
    });
  }, [selected, runs, notifications, approvals]);

  if (!selected || !journey) {
    return (
      <section className="mt-6 rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold text-foreground">Live journey</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No workflows yet. Create one below and the journey will follow its real
          schedule, runs, and deliveries.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Live journey</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {journey.steps.filter((step) => step.state !== "upcoming").length} recorded
            steps. The highlighted step is where this workflow is now.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={selected.enabled}
          aria-label={`Switch ${selected.name} on or off`}
          onClick={() => onToggle(selected, !selected.enabled)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            selected.enabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              selected.enabled ? "translate-x-5" : ""
            }`}
          />
        </button>
      </div>

      {workflows.length > 1 ? (
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Workflows">
          {workflows.map((workflow) => {
            const active = workflow.id === selected.id;
            return (
              <button
                key={workflow.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelectedId(workflow.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {workflow.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-5">
        <StageRail phase={journey.phase} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[16rem_1fr]">
        <aside className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {selected.name}
          </p>
          <p className="mt-3 text-xl font-semibold text-foreground">{journey.current.title}</p>
          <p className="mt-2 text-sm text-muted-foreground">{journey.current.detail}</p>
          {selected.requires_approval ? (
            <p className="mt-3 text-xs font-medium text-foreground">Needs approval before it acts.</p>
          ) : null}
          {selected.last_error ? (
            <p className="mt-3 text-xs text-destructive">Last error: {selected.last_error}</p>
          ) : null}
        </aside>

        <div>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-foreground">What has happened</h3>
            <span className="rounded-full bg-progress/10 px-2.5 py-0.5 text-[11px] font-semibold text-progress">
              {journey.phase === "wrap"
                ? "Wrapped up"
                : journey.phase === "start"
                  ? "Not started"
                  : "In progress"}
            </span>
          </div>
          <JourneyTimeline steps={journey.steps} />
          <ul className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-progress" /> Done
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-primary" /> Current
            </li>
            <li className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full border border-border" /> Upcoming
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
