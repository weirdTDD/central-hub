// Central Hub — the notifications page.
//
// Everything on this page is a fact from the database: a notification exists
// because a workflow really delivered it, a workflow shows the occurrence it will
// really run at, and the run history shows what really happened — including the
// failures.
//
// The page follows src/features/tasks/TasksPage.jsx: the same shell, the same
// input/button vocabulary, and the same loading / error / "Not connected" / empty
// ladder.

import { useMemo, useState } from "react";
import {
  Bell,
  BellRing,
  CalendarClock,
  Check,
  Clock,
  Info,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import AppShell from "../../components/AppShell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useNotifications } from "./NotificationsContext";
import { CONDITION_TYPES, EVENT_LABELS, EVENT_TYPES } from "./workflowEngine.js";
import WorkflowJourney from "./WorkflowJourney";

/**
 * The states of a notification, with the plain-language meaning of each.
 *
 * The badge always carries the state's NAME, so the state is never conveyed by
 * colour alone.
 */
const NOTIFICATION_STATUS_META = {
  scheduled: {
    label: "Scheduled",
    className: "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300",
    meaning: "Planned, but not handed to the channel yet.",
  },
  sent: {
    label: "Sent",
    className: "bg-primary/10 text-primary",
    meaning: "Handed to the channel; the channel has not confirmed it yet.",
  },
  delivered: {
    label: "Delivered",
    className: "bg-progress/10 text-progress",
    meaning: "The channel confirmed it — it is in your inbox.",
  },
  acknowledged: {
    label: "Acknowledged",
    className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    meaning: "You have seen it and acted on it.",
  },
  failed: {
    label: "Failed",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    meaning: "The delivery failed. The reason is shown in the run history.",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400",
    meaning: "It was not delivered.",
  },
};

const RUN_STATUS_META = {
  scheduled: "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300",
  running: "bg-primary/10 text-primary",
  succeeded: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  skipped: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  cancelled: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400",
  awaiting_approval:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

const CONDITION_LABELS = {
  task_overdue: "A task is overdue",
  task_due_today: "A task is due today",
  unattributed_sessions: "A session has no task",
};

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

/**
 * @param {string} value an ISO timestamp
 * @returns {string|null} a readable local timestamp, or null when there is none
 */
function formatTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StatusBadge({ status }) {
  const meta = NOTIFICATION_STATUS_META[status] ?? {
    label: status,
    className: "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-primary" : "bg-gray-300 dark:bg-zinc-600"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

function NewWorkflowForm({ onCreate, busy }) {
  const [values, setValues] = useState({
    name: "",
    kind: "daily",
    at: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    everyMinutes: 60,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    condition: "task_overdue",
    title: "",
    body: "",
    requiresApproval: false,
  });
  const [error, setError] = useState("");

  const update = (key) => (event) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  const toggleWeekday = (day) =>
    setValues((current) => ({
      ...current,
      weekdays: current.weekdays.includes(day)
        ? current.weekdays.filter((value) => value !== day)
        : [...current.weekdays, day],
    }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!values.name.trim()) {
      setError("Name is required.");
      return;
    }
    if (values.kind === "weekly" && values.weekdays.length === 0) {
      setError("Choose at least one day of the week.");
      return;
    }

    const result = await onCreate({
      name: values.name.trim(),
      kind: values.kind,
      at: values.at,
      weekdays: values.weekdays,
      everyMinutes: Number(values.everyMinutes),
      timezone: values.timezone,
      kindName: values.condition,
      title: values.title.trim() || values.name.trim(),
      body: values.body.trim() || null,
      requiresApproval: values.requiresApproval,
      conditions:
        values.condition === "none"
          ? []
          : [{ type: values.condition }],
    });

    if (!result.ok) {
      setError(result.error || "The workflow could not be created.");
      return;
    }

    setValues((current) => ({ ...current, name: "", title: "", body: "" }));
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-white p-5 dark:bg-zinc-900"
    >
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        New workflow
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        A workflow checks a condition — at a scheduled time, or when something
        happens — and writes a notification when the condition holds.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Name
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.name}
            onChange={update("name")}
            placeholder="Morning overdue check"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            When
          </label>
          <Select value={values.kind} onValueChange={(kind) => update("kind")({ target: { value: kind } })}>
            <SelectTrigger className="mt-1" aria-label="When">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Every day</SelectItem>
              <SelectItem value="weekly">On selected days</SelectItem>
              <SelectItem value="interval">Every N minutes</SelectItem>
              {EVENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {EVENT_LABELS[type] ?? type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {EVENT_TYPES.includes(values.kind) ? (
          <div className="sm:col-span-2 rounded-xl border border-border px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
            The workflow acts when a task is completed. The worker records the event
            once, so the same completion never produces a second notification.
          </div>
        ) : null}

        {EVENT_TYPES.includes(values.kind) ? null : values.kind === "interval" ? (
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
              Every (minutes)
            </label>
            <input
              type="number"
              min="1"
              className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
              value={values.everyMinutes}
              onChange={update("everyMinutes")}
            />
          </div>
        ) : (
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
              At
            </label>
            <input
              type="time"
              className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
              value={values.at}
              onChange={update("at")}
            />
          </div>
        )}

        {values.kind === "weekly" ? (
          <fieldset className="sm:col-span-2">
            <legend className="text-xs font-medium text-gray-500 dark:text-gray-400">
              Days
            </legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAYS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => toggleWeekday(day.value)}
                  aria-pressed={values.weekdays.includes(day.value)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    values.weekdays.includes(day.value)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-gray-600 hover:border-primary/40 dark:text-gray-300"
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {EVENT_TYPES.includes(values.kind) ? null : (
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Timezone
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.timezone}
            onChange={update("timezone")}
          />
        </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Only when
          </label>
          <Select value={values.condition} onValueChange={(condition) => update("condition")({ target: { value: condition } })}>
            <SelectTrigger className="mt-1" aria-label="Only when">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Always</SelectItem>
              {CONDITION_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {CONDITION_LABELS[type] ?? type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Notification title
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.title}
            onChange={update("title")}
            placeholder="Overdue tasks"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Message (optional)
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.body}
            onChange={update("body")}
            placeholder="What the notification should say"
          />
        </div>

        <div className="sm:col-span-2 flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Ask before acting
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              The run waits for your approval instead of delivering straight away.
            </p>
          </div>
          <Toggle
            label="Ask before acting"
            checked={values.requiresApproval}
            onChange={(next) =>
              setValues((current) => ({ ...current, requiresApproval: next }))
            }
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
      >
        <CalendarClock className="h-4 w-4" />
        {busy ? "Saving..." : "Create workflow"}
      </button>
    </form>
  );
}

function PreferencesCard({ preferences, onSave }) {
  const [values, setValues] = useState({
    timezone:
      preferences?.timezone ??
      (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    quietHoursStart: preferences?.quiet_hours_start ?? "",
    quietHoursEnd: preferences?.quiet_hours_end ?? "",
  });
  const [saved, setSaved] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const result = await onSave(values);
    setSaved(result.ok);
    if (!result.ok) return;
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-border bg-white p-5 dark:bg-zinc-900"
    >
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Delivery preferences
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Quiet hours hold notifications back until the window ends — they are not
        dropped.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Timezone
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.timezone}
            onChange={(event) =>
              setValues((current) => ({ ...current, timezone: event.target.value }))
            }
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Quiet hours from
          </label>
          <input
            type="time"
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.quietHoursStart}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                quietHoursStart: event.target.value,
              }))
            }
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            until
          </label>
          <input
            type="time"
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.quietHoursEnd}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                quietHoursEnd: event.target.value,
              }))
            }
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Check className="h-4 w-4" />
          Save preferences
        </button>
        {saved ? (
          <span className="text-sm text-green-700 dark:text-green-300">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  );
}

export default function NotificationsPage() {
  const {
    notifications,
    workflows,
    runs,
    approvals,
    pendingApprovals,
    preferences,
    loading,
    error,
    errorScope,
    isConfigured,
    truncated,
    busy,
    acknowledge,
    snooze,
    remove,
    createWorkflow,
    setWorkflowEnabled,
    decideApproval,
    savePreferences,
    refresh,
  } = useNotifications();

  const [removing, setRemoving] = useState(null);

  const lastRun = useMemo(() => runs[0] ?? null, [runs]);
  const openNotifications = useMemo(
    () => notifications.filter((item) => item.status !== "acknowledged"),
    [notifications]
  );

  const handleRemove = async (notification) => {
    if (!window.confirm("Delete this notification? This cannot be undone.")) return;
    setRemoving(notification.id);
    try {
      await remove(notification);
    } finally {
      setRemoving(null);
    }
  };

  const emptyMessage = (() => {
    if (loading) return "Loading notifications...";
    if (error) return "Could not load the notifications.";
    if (!isConfigured) {
      return "Not connected. Configure Supabase to load your notifications.";
    }
    return "No notifications yet. A workflow will write one when its condition holds.";
  })();

  return (
    <AppShell currentPath="/notifications">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-col gap-1">
            <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {openNotifications.length} open of {notifications.length} delivered
              {truncated ? " — the list is truncated, not complete" : ""}
            </p>
          </div>

          {error ? (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-200"
            >
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {error}
                {errorScope === "action" ? " (the last action failed)" : null}
              </span>
            </div>
          ) : null}

          {/* The scheduler: what runs the workflows, and what it did last. */}
          <section className="mt-6 rounded-2xl border border-border bg-white p-5 dark:bg-zinc-900">
            <div className="flex items-start gap-3">
              <Clock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  Scheduler
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  The schedule lives in the database, so it survives a restart. It is
                  executed by the workflow worker ({" "}
                  <code className="rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-zinc-800">
                    node scripts/worker.mjs
                  </code>
                  ) — while that process is not running, no workflow is executed. Only
                  the in-app channel exists; email and push are not connected.
                </p>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                  {lastRun
                    ? `Last recorded run: ${formatTimestamp(lastRun.created_at) ?? "unknown"} — ${lastRun.status} (attempt ${lastRun.attempt}).`
                    : "No run has been recorded yet."}
                </p>
              </div>
              <button
                type="button"
                onClick={refresh}
                className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-primary/40 dark:text-gray-200"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>
          </section>

          {/* Approvals: sensitive actions wait for the user. */}
          {pendingApprovals.length > 0 ? (
            <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900/40 dark:bg-amber-950/20">
              <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
                <BellRing className="h-4 w-4" />
                Waiting for your approval
              </h2>
              <ul className="mt-3 space-y-3">
                {pendingApprovals.map((approval) => (
                  <li
                    key={approval.id}
                    className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between dark:border-amber-900/40 dark:bg-zinc-900"
                  >
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {approval.payload?.workflow_name ?? "A workflow wants to act"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Requested {formatTimestamp(approval.created_at) ?? "unknown"}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => decideApproval(approval, "approved")}
                        className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                      >
                        <Check className="h-3.5 w-3.5" />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => decideApproval(approval, "rejected")}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-red-300 dark:text-gray-200"
                      >
                        <X className="h-3.5 w-3.5" />
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* The inbox. */}
          <section className="mt-6 rounded-2xl border border-border bg-white p-5 dark:bg-zinc-900">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              <Bell className="h-4 w-4" />
              Inbox
            </h2>

            {loading ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Loading notifications...</p>
            ) : notifications.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                {emptyMessage}
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-border">
                {notifications.map((notification) => (
                  <li key={notification.id} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={notification.status} />
                          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                            {notification.title}
                          </p>
                        </div>
                        {notification.body ? (
                          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                            {notification.body}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          {NOTIFICATION_STATUS_META[notification.status]?.meaning}
                        </p>
                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {notification.scheduled_for
                            ? `Planned for ${formatTimestamp(notification.scheduled_for) ?? "unknown"}`
                            : null}
                          {notification.sent_at
                            ? ` · sent ${formatTimestamp(notification.sent_at) ?? "unknown"}`
                            : null}
                          {notification.delivered_at
                            ? ` · delivered ${formatTimestamp(notification.delivered_at) ?? "unknown"}`
                            : null}
                          {notification.acknowledged_at
                            ? ` · acknowledged ${formatTimestamp(notification.acknowledged_at) ?? "unknown"}`
                            : null}
                          {notification.snoozed_until
                            ? ` · snoozed until ${formatTimestamp(notification.snoozed_until) ?? "unknown"}`
                            : null}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-wrap gap-2">
                        {notification.status === "delivered" ? (
                          <button
                            type="button"
                            onClick={() => acknowledge(notification)}
                            className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Acknowledge
                          </button>
                        ) : null}
                        {notification.status !== "acknowledged" ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                snooze(
                                  notification,
                                  Date.now() + 60 * 60 * 1000
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-primary/40 dark:text-gray-200"
                            >
                              <Clock className="h-3.5 w-3.5" />
                              Snooze 1h
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                snooze(
                                  notification,
                                  Date.now() + 24 * 60 * 60 * 1000
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-primary/40 dark:text-gray-200"
                            >
                              Snooze 24h
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => handleRemove(notification)}
                          disabled={removing === notification.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-red-300 disabled:opacity-50 dark:text-gray-200"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <WorkflowJourney
            workflows={workflows}
            runs={runs}
            notifications={notifications}
            approvals={approvals}
            onToggle={setWorkflowEnabled}
          />

          <div className="mt-6">
            <NewWorkflowForm onCreate={createWorkflow} busy={busy} />
          </div>

          <div className="mt-6">
            <PreferencesCard preferences={preferences} onSave={savePreferences} />
          </div>

          {/* The execution history. */}
          <section className="mt-6 rounded-2xl border border-border bg-white p-5 dark:bg-zinc-900">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Execution history
            </h2>
            {runs.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
                No run has been recorded yet. A run is written for every occurrence —
                including the ones that did nothing.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-border">
                {runs.slice(0, 25).map((run) => (
                  <li
                    key={run.id}
                    className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            RUN_STATUS_META[run.status] ??
                            "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300"
                          }`}
                        >
                          {run.status}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          attempt {run.attempt}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                          {formatTimestamp(run.created_at) ?? "unknown"}
                        </span>
                      </div>
                      {run.error ? (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-300">
                          {run.error}
                        </p>
                      ) : null}
                    </div>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {run.result?.reason ?? run.idempotency_key}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
    </AppShell>
  );
}
