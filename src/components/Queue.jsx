import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { Skeleton } from "../components/ui/skeleton";
import {
  estimateText,
  formatDayHeading,
  primaryAction,
  priorityLabel,
  statusLabel,
} from "../dashboard/todayView";

function detailLine(item) {
  const parts = [
    statusLabel(item.status),
    priorityLabel(item.priority),
    estimateText(item.estimatedSeconds),
  ];
  if (item.dueDate) parts.push(formatDayHeading(item.dueDate));
  return parts.join(" · ");
}

/**
 * Open work waiting its turn. The first item is next. There is no clock.
 */
export default function Queue({
  title = "Queue",
  description = "Open work, in order. The first item is next.",
  items = [],
  state = "ready",
  error = "",
  actionError = "",
  busyId = null,
  onAction,
  headerTo,
  headerLabel,
  emptyTitle = "Queue is clear",
  emptyDetail = "No open work is waiting.",
  className,
}) {
  const visible = state === "ready" ? items : [];

  return (
    <section aria-labelledby="queue-heading" className={cn("rounded-xl border border-border bg-card-peach p-3 shadow-sm ", className)}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 id="queue-heading" className="text-base font-semibold">{title}</h2>
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
          <Notice role="alert" tone="error" title="Could not load the queue" detail={error || "Could not load the queue."} />
        ) : null}
        {state === "ready" && visible.length === 0 ? (
          <Notice title={emptyTitle} detail={emptyDetail} />
        ) : null}
        {visible.length > 0 ? (
          <ol className="space-y-2">
            {visible.map((item, index) => {
              const action = onAction ? primaryAction(item.status) : null;
              const next = item.isNext;
              return (
                <li
                  key={item.id}
                  className={cn(
                    "flex items-start gap-2 rounded-xl border px-2.5 py-2.5",
                    next ? "border-primary bg-primary/10" : "border-border bg-background"
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      next ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    )}
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {next ? (
                      <p className="text-xs font-semibold uppercase tracking-wide text-primary">Next</p>
                    ) : null}
                    <h3 className="text-sm font-semibold">{item.title || "Untitled"}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{detailLine(item)}</p>
                  </div>
                  {action ? (
                    <button
                      type="button"
                      onClick={() => onAction(item, action)}
                      disabled={busyId === item.id}
                      className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-primary px-2.5 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    >
                      {busyId === item.id ? "Saving…" : action.label}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}
        {actionError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">{actionError}</p>
        ) : null}
      </div>
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
