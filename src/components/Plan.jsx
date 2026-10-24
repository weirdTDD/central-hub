import { Link } from "react-router-dom";
import { Check } from "lucide-react";
import { cn } from "../lib/utils";
import { Skeleton } from "../components/ui/skeleton";
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
    <section aria-labelledby="plan-heading" className={cn("rounded-xl border border-border bg-card-cream p-3 shadow-sm ", className)}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="plan-heading" className="text-base font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerTo && headerLabel ? (
          <Link
            to={headerTo}
            className="inline-flex min-h-9 items-center justify-center text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {headerLabel}
          </Link>
        ) : null}
      </div>

      <div className="mt-3">
        {state === "unconfigured" ? (
          <Notice title="Not connected" detail="Configure Supabase to load tasks." />
        ) : null}
        {state === "loading" ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-4 w-1/3 mb-1" />
            <Skeleton className="h-8 w-full mb-2" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : null}
        {state === "error" ? (
          <Notice role="alert" tone="error" title="Could not load the plan" detail={error || "Could not load the plan."} />
        ) : null}
        {state === "ready" && visible.length === 0 ? (
          <Notice title={emptyTitle} detail={emptyDetail} />
        ) : null}
        {visible.length > 0 ? (
          <ol className="space-y-2 border-l border-border pl-3">
            {visible.map((item) => {
              const action = onAction ? primaryAction(item.status) : null;
              const next = item.isNext;
              return (
                <li key={item.id} className="relative">
                  <span
                    className={cn(
                      "absolute top-4 -left-[18px] h-2 w-2 rounded-full border-2",
                      next ? "border-primary bg-primary" : "border-border bg-card"
                    )}
                    aria-hidden="true"
                  />
                  <article
                    className={cn(
                      "rounded-xl border px-2.5 py-2.5",
                      next
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        {next ? (
                          <p className="text-xs font-semibold uppercase tracking-wide">Next</p>
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
                            "inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                            next
                              ? "bg-primary-foreground text-primary"
                              : "bg-secondary text-secondary-foreground"
                          )}
                        >
                          {item.status === "completed" ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
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
          <p role="alert" className="mt-2 text-sm text-destructive">{actionError}</p>
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
        "rounded-xl border px-3 py-2 text-sm",
        tone === "error" ? "border-destructive/40 bg-destructive/5" : "border-border bg-background"
      )}
    >
      <p className="font-semibold text-foreground">{title}</p>
      {detail ? <p className="mt-1 text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
