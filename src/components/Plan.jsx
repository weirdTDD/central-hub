import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import {
  estimateText,
  formatDayHeading,
  primaryAction,
  priorityLabel,
  statusLabel,
} from "../dashboard/todayView";

function detailLine(item, showDate) {
  const parts = [
    statusLabel(item.status),
    priorityLabel(item.priority),
    estimateText(item.estimatedSeconds),
  ];
  if (showDate && item.dueDate) parts.push(formatDayHeading(item.dueDate));
  return parts.join(" · ");
}

/**
 * The day's plan: tasks due then, in queue order, with no invented start time.
 */
export default function Plan({
  title = "Plan",
  description = "Tasks due this day. A task has no start time.",
  items = [],
  state = "ready",
  error = "",
  actionError = "",
  busyId = null,
  onAction,
  headerTo,
  headerLabel,
  footer = null,
  emptyTitle = "Nothing is due",
  emptyDetail = "No task is due on this day.",
  showDate = false,
  className,
}) {
  const visible = state === "ready" ? items : [];

  return (
    <section aria-labelledby="plan-heading" className={cn("rounded-3xl border border-border bg-card p-4 sm:p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="plan-heading" className="text-lg font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerTo && headerLabel ? (
          <Link
            to={headerTo}
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {headerLabel}
          </Link>
        ) : null}
      </div>

      <div className="mt-4">
        {state === "unconfigured" ? (
          <Notice title="Not connected" detail="Configure Supabase to load tasks." />
        ) : null}
        {state === "loading" ? <Notice title="Loading…" detail="Loading tasks due this day." /> : null}
        {state === "error" ? (
          <Notice role="alert" tone="error" title="Could not load the plan" detail={error || "Could not load the plan."} />
        ) : null}
        {state === "ready" && visible.length === 0 ? (
          <Notice title={emptyTitle} detail={emptyDetail} />
        ) : null}
        {visible.length > 0 ? (
          <ol className="space-y-3 border-l border-border pl-4">
            {visible.map((item) => {
              const action = onAction ? primaryAction(item.status) : null;
              const next = item.isNext;
              return (
                <li key={item.id} className="relative">
                  <span
                    className={cn(
                      "absolute top-5 -left-[21px] h-2.5 w-2.5 rounded-full border-2",
                      next ? "border-primary bg-primary" : "border-border bg-card"
                    )}
                    aria-hidden="true"
                  />
                  <article
                    className={cn(
                      "rounded-2xl border px-3 py-3",
                      next
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {next ? (
                          <p className="text-[11px] font-semibold uppercase tracking-wide">Next</p>
                        ) : null}
                        <h3 className="text-sm font-semibold">{item.title || "Untitled"}</h3>
                        <p className={cn("mt-1 text-xs", next ? "text-primary-foreground/80" : "text-muted-foreground")}>
                          {detailLine(item, showDate)}
                        </p>
                      </div>
                      {action ? (
                        <button
                          type="button"
                          onClick={() => onAction(item, action)}
                          disabled={busyId === item.id}
                          className={cn(
                            "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                            next
                              ? "bg-primary-foreground text-primary"
                              : "bg-secondary text-secondary-foreground"
                          )}
                        >
                          {item.status === "completed" ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
                          {busyId === item.id ? "Saving…" : action.label}
                        </button>
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ol>
        ) : null}
        {actionError ? (
          <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p>
        ) : null}
      </div>
      {footer}
    </section>
  );
}

function Notice({ role = "status", title, detail, tone = "neutral" }) {
  return (
    <div
      role={role}
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm",
        tone === "error" ? "border-destructive/40 bg-destructive/5" : "border-border bg-background"
      )}
    >
      <p className="font-semibold text-foreground">{title}</p>
      {detail ? <p className="mt-1 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
