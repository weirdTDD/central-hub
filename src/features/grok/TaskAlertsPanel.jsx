import { useCallback, useEffect, useState } from "react";
import { BellRing, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listTaskReferences } from "../../lib/tasks.js";
import { isSupabaseConfigured } from "../../lib/supabase.js";
import {
  deleteTaskAlert,
  insertTaskAlert,
  listTaskAlerts,
  updateTaskAlert,
} from "../../lib/grok.js";
import {
  REPEAT_LABELS,
  REPEAT_RULES,
  isoToLocalDateTime,
  localDateTimeToIso,
  validateAlertDraft,
  validateAlertPatch,
} from "./alerts.js";
import { useAlertRevision } from "./alertRevision.js";

const EMPTY = {
  taskId: "",
  title: "",
  note: "",
  dueLocal: "",
  repeat: "none",
};

/**
 * Create, edit, and delete reminders for tasks on this account.
 */
export default function TaskAlertsPanel() {
  const { revision, runnerError } = useAlertRevision();
  const [alerts, setAlerts] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    Promise.all([listTaskAlerts(), listTaskReferences()])
      .then(([alertRows, taskPage]) => {
        if (!active) return;
        setAlerts(alertRows);
        setTasks(taskPage.rows ?? []);
        setError("");
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught?.message || "Reminders could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision, reloadToken]);

  const taskTitle = (id) => tasks.find((task) => task.id === id)?.title ?? "";

  const onSubmit = async (event) => {
    event.preventDefault();
    setError("");
    const dueAt = localDateTimeToIso(form.dueLocal, zone);
    if (!dueAt) {
      setError("Choose a due date and time.");
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        const patch = validateAlertPatch(
          {
            dueAt,
            title: form.title,
            note: form.note,
            repeat: form.repeat,
            status: "scheduled",
          },
          { now: new Date(), timeZone: zone }
        );
        if (!patch.ok) {
          setError(patch.error);
          return;
        }
        const updated = await updateTaskAlert(editingId, patch.value);
        if (!updated) {
          setError("That reminder is not on your account.");
          return;
        }
      } else {
        const draft = validateAlertDraft(
          {
            taskId: form.taskId,
            taskTitle: taskTitle(form.taskId),
            title: form.title,
            note: form.note,
            dueAt,
            repeat: form.repeat,
            createdBy: "user",
          },
          { now: new Date(), timeZone: zone }
        );
        if (!draft.ok) {
          setError(draft.error);
          return;
        }
        await insertTaskAlert(draft.value);
      }
      setForm(EMPTY);
      setEditingId(null);
      reload();
    } catch (caught) {
      setError(caught?.message || "The reminder could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (alert) => {
    setEditingId(alert.id);
    setPendingDelete(null);
    setForm({
      taskId: alert.task_id,
      title: alert.title,
      note: alert.note ?? "",
      dueLocal: isoToLocalDateTime(alert.due_at, alert.timezone || zone),
      repeat: alert.repeat,
    });
  };

  const remove = async (id) => {
    setError("");
    try {
      const removed = await deleteTaskAlert(id);
      if (!removed) setError("That reminder is not on your account.");
      if (editingId === id) {
        setEditingId(null);
        setForm(EMPTY);
      }
      setPendingDelete(null);
      reload();
    } catch (caught) {
      setError(caught?.message || "The reminder could not be deleted.");
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-muted-foreground">
          <BellRing className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-foreground">Task reminders</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A reminder belongs to one task. It is saved here, so it still appears if this tab was closed. A closed computer cannot show it until you open Central Hub again.
          </p>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Not connected. Add the Supabase URL and anon key before reminders can be saved.
        </p>
      ) : null}

      {loading ? <p className="mt-4 text-sm text-muted-foreground">Loading reminders…</p> : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>
      ) : null}
      {runnerError ? (
        <p role="alert" className="mt-4 text-sm text-destructive">{runnerError}</p>
      ) : null}

      {isSupabaseConfigured ? (
        <form onSubmit={onSubmit} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm sm:col-span-2">
            <span className="text-muted-foreground">Task</span>
            <Select
              value={form.taskId || undefined}
              onValueChange={(taskId) => setForm((current) => ({ ...current, taskId }))}
              disabled={Boolean(editingId)}
            >
              <SelectTrigger className="mt-1" aria-label="Task">
                <SelectValue placeholder="Choose a task" />
              </SelectTrigger>
              <SelectContent>
                {tasks.map((task) => (
                  <SelectItem key={task.id} value={task.id}>
                    {task.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Due</span>
            <Input
              className="mt-1 h-11"
              type="datetime-local"
              value={form.dueLocal}
              aria-label="Due"
              onChange={(event) => setForm((current) => ({ ...current, dueLocal: event.target.value }))}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Repeat</span>
            <Select
              value={form.repeat}
              onValueChange={(repeat) => setForm((current) => ({ ...current, repeat }))}
            >
              <SelectTrigger className="mt-1" aria-label="Repeat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPEAT_RULES.map((rule) => (
                  <SelectItem key={rule} value={rule}>
                    {REPEAT_LABELS[rule]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-muted-foreground">Title, if you want one other than the task</span>
            <Input
              className="mt-1 h-11"
              value={form.title}
              maxLength={200}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-muted-foreground">Note</span>
            <Input
              className="mt-1 h-11"
              value={form.note}
              maxLength={500}
              onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
            />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" className="min-h-11" disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save reminder" : "Add reminder"}
            </Button>
            {editingId ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY);
                }}
              >
                Cancel edit
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      {isSupabaseConfigured && !loading && alerts.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No reminders yet.</p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {alerts.map((alert) => (
          <li key={alert.id} className="rounded-xl border border-border bg-background px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{alert.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {taskTitle(alert.task_id) || "Task"} · {formatDue(alert)} · {REPEAT_LABELS[alert.repeat] || alert.repeat}
                  {alert.status === "paused" ? " · Paused" : ""}
                  {alert.status === "fired" ? " · Delivered" : ""}
                  {alert.created_by === "grok" ? " · Set by Grok" : ""}
                </p>
                {alert.note ? <p className="mt-1 text-sm text-foreground">{alert.note}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                {alert.status !== "fired" ? (
                  <Button type="button" variant="outline" className="min-h-11" onClick={() => startEdit(alert)}>
                    Edit
                  </Button>
                ) : null}
                {pendingDelete === alert.id ? (
                  <Button type="button" variant="destructive" className="min-h-11" onClick={() => remove(alert.id)}>
                    Delete reminder
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    aria-label={`Delete ${alert.title}`}
                    onClick={() => setPendingDelete(alert.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDue(alert) {
  const date = new Date(alert.due_at);
  if (!Number.isFinite(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: alert.timezone || undefined,
  }).format(date);
}
