import { useMemo, useState } from "react";
import {
  Check,
  ClipboardList,
  Edit,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useTasks } from "./TasksContext";
import AppShell from "../../components/AppShell";
import Plan from "../../components/Plan";
import Queue from "../../components/Queue";
import { plannedTasks, workQueue } from "../../dashboard/todayView";
import {
  ACTIVE_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  allowedNextStatuses,
  isValidStatusTransition,
} from "./taskUtils";
import {
  durationStringToSeconds,
  formatDuration,
  isParseableDuration,
} from "../../dashboard/logUtils";
import { DateField } from "../../components/ui/date-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";

const ESTIMATE_PLACEHOLDER = "e.g. 4h 30m";

function StatusBadge({ status }) {
  const label =
    TASK_STATUSES.find((s) => s.value === status)?.label ?? status;
  const base =
    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium";
  const style = {
    todo: "bg-gray-100 text-gray-700 dark:bg-zinc-800 dark:text-gray-300",
    in_progress: "bg-primary/10 text-primary",
    in_review: "bg-progress/10 text-progress",
    completed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    blocked: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    cancelled: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400",
  }[status] ?? "bg-gray-100 text-gray-700";

  return (
    <span className={`${base} ${style}`}>{label}</span>
  );
}

function NewTaskForm({ onAdd }) {
  const [values, setValues] = useState({
    title: "",
    description: "",
    priority: "medium",
    dueDate: "",
    estimate: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const update = (key) => (event) =>
    setValues((v) => ({ ...v, [key]: event.target.value }));

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    if (!values.title.trim()) {
      setError("Title is required.");
      return;
    }
    if (values.estimate && !isParseableDuration(values.estimate)) {
      setError('Estimate must be a duration such as "4h 30m", "90m" or "90".');
      return;
    }

    setSaving(true);
    try {
      await onAdd({
        title: values.title,
        description: values.description,
        priority: values.priority,
        dueDate: values.dueDate || null,
        estimatedSeconds: values.estimate
          ? durationStringToSeconds(values.estimate)
          : null,
      });
      setValues({
        title: "",
        description: "",
        priority: "medium",
        dueDate: "",
        estimate: "",
      });
    } catch (err) {
      setError(err?.message || "Could not create this task.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-2xl border border-border bg-white p-5 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        New Task
      </h2>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Title
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.title}
            onChange={update("title")}
            placeholder="What needs to be done?"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Priority
          </label>
          <Select value={values.priority} onValueChange={(priority) => update("priority")({ target: { value: priority } })}>
            <SelectTrigger className="mt-1" aria-label="Priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TASK_PRIORITIES.map((priority) => (
                <SelectItem key={priority.value} value={priority.value}>{priority.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Due date
          </label>
          <DateField
            value={values.dueDate}
            onChange={(dueDate) => update("dueDate")({ target: { value: dueDate } })}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Estimate
          </label>
          <input
            className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.estimate}
            onChange={update("estimate")}
            placeholder={ESTIMATE_PLACEHOLDER}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400">
            Description
          </label>
          <textarea
            rows={3}
            className="mt-1 block w-full resize-none rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
            value={values.description}
            onChange={update("description")}
            placeholder="Optional details or acceptance criteria"
          />
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {saving ? "Adding..." : "Add Task"}
        </button>
      </div>
    </form>
  );
}

function EditTaskForm({ task, onSave, onCancel, saving, error }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [estimate, setEstimate] = useState(
    task.estimatedSeconds === null ? "" : formatDuration(Math.round(task.estimatedSeconds / 60))
  );
  const [validationError, setValidationError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setValidationError("");
    if (!title.trim()) {
      setValidationError("Title is required.");
      return;
    }
    if (estimate && !isParseableDuration(estimate)) {
      setValidationError('Estimate must be a duration such as "4h 30m", "90m" or "90".');
      return;
    }
    const estInput = estimate
      ? durationStringToSeconds(estimate)
      : null;
    if (
      task.estimatedSeconds !== null &&
      task.estimatedSeconds !== undefined &&
      estInput === null
    ) {
      if (
        !window.confirm("Clearing the estimate removes the planned duration. Continue?")
      ) {
        return;
      }
    }
    await onSave({
      title,
      description,
      priority,
      dueDate: dueDate || null,
      estimatedSeconds: estInput,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-2xl border border-border bg-gray-50 p-4 dark:bg-zinc-950">
      <input
        className="mb-3 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        required
      />
      <textarea
        rows={3}
        className="mb-3 block w-full resize-none rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger aria-label="Priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TASK_PRIORITIES.map((item) => (
              <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DateField value={dueDate} onChange={setDueDate} />
        <input
          className="block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-zinc-950 dark:text-gray-100"
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          placeholder={ESTIMATE_PLACEHOLDER}
        />
      </div>

      {validationError ? (
        <p role="alert" className="mt-2 text-sm text-red-600">{validationError}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>
      ) : null}

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          <Save className="h-4 w-4" /> {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

function TaskRow({ task, onUpdateStatus, onComplete, onReopen, onEdit, onDelete }) {
  // Only the transitions the state machine allows are offered, so the control can
  // never present a move that would be rejected.
  const nextStatuses = allowedNextStatuses(task.status);
  const canComplete = nextStatuses.includes("completed");
  const canReopen = nextStatuses.includes("todo");

  return (
    <li className="rounded-xl border border-border bg-background transition-colors hover:border-primary/40">
      <div className="grid grid-cols-12 items-start gap-3 px-4 py-3 sm:gap-4 sm:px-5">
        <div className="col-span-full flex items-start justify-between sm:col-span-5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {task.title}
            </p>
            {task.description ? (
              <p className="mt-1 line-clamp-2 text-sm text-gray-600 dark:text-gray-400">
                {task.description}
              </p>
            ) : null}
          </div>
          <StatusBadge status={task.status} />
        </div>

        <div className="col-span-full flex flex-wrap items-center gap-2 sm:col-span-4 sm:justify-end">
          <Select value={task.status} onValueChange={(status) => onUpdateStatus(task, status)}>
            <SelectTrigger className="sm:w-44" aria-label={`Change status of ${task.title}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={task.status}>
                {TASK_STATUSES.find((status) => status.value === task.status)?.label ?? task.status}
              </SelectItem>
              {nextStatuses.map((status) => (
                <SelectItem key={status} value={status}>
                  {TASK_STATUSES.find((item) => item.value === status)?.label ?? status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {canComplete ? (
            <button
              type="button"
              onClick={() => onComplete(task)}
              className="inline-flex items-center gap-1 rounded-lg bg-progress/10 px-2.5 py-1 text-xs font-semibold text-progress hover:bg-progress/20"
              title="Mark complete"
            >
              <Check className="h-3.5 w-3.5" /> Complete
            </button>
          ) : null}

          {canReopen ? (
            <button
              type="button"
              onClick={() => onReopen(task)}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-white px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
              title="Reopen"
            >
              <X className="h-3.5 w-3.5" /> Reopen
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => onEdit(task)}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-primary dark:hover:bg-zinc-800"
            aria-label={`Edit ${task.title}`}
          >
            <Edit className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(task)}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-red-100 hover:text-red-600"
            aria-label={`Delete ${task.title}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        <div className="col-span-full flex gap-4 text-xs text-gray-600 sm:col-span-3 sm:col-start-1 dark:text-gray-400">
          {task.priority ? (
            <span>
              Priority:{" "}
              {TASK_PRIORITIES.find((p) => p.value === task.priority)?.label ??
                task.priority}
            </span>
          ) : null}
          {task.dueDate ? <span>Due: {task.dueDate}</span> : null}
          {task.estimatedSeconds !== null && task.estimatedSeconds !== undefined ? (
            <span>Est: {formatDuration(Math.round(task.estimatedSeconds / 60))}</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default function TasksPage() {
  const {
     tasks,
     addTask,
     updateTask,
     deleteTask,
     transitionTask,
     loading,
    error,
    isConfigured,
    totalTasks,
    truncated,
    activeTasks,
    completedCount,
  } = useTasks();
  const [filter, setFilter] = useState("all");
  const [editingId, setEditingId] = useState(null);
  const [editError, setEditError] = useState("");
  const [savingId, setSavingId] = useState(null);

  const queueItems = useMemo(() => workQueue(tasks).slice(0, 6), [tasks]);
  const planItems = useMemo(() => plannedTasks(tasks).slice(0, 6), [tasks]);
  const taskState = !isConfigured ? "unconfigured" : loading ? "loading" : error ? "error" : "ready";

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (filter === "active") return ACTIVE_STATUSES.includes(t.status);
        if (filter === "completed") return t.status === "completed";
        if (filter === "blocked") return t.status === "blocked";
        return true;
      }),
    [tasks, filter]
  );

  const handleAdd = async (values) => {
    await addTask(values);
  };

  const handleStatusChange = async (task, nextStatus) => {
    if (nextStatus === task.status) return;
    if (!isValidStatusTransition(task.status, nextStatus)) {
      window.alert(
        `Cannot move "${task.title}" from "${task.status}" to "${nextStatus}".`
      );
      return;
    }
    setSavingId(task.id);
    try {
      await transitionTask(task.id, nextStatus);
    } catch (err) {
      window.alert(err?.message || "Could not update task status.");
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveEdit = async (task, values) => {
    setSavingId(task.id);
    setEditError("");
    try {
      await updateTask(task.id, values);
      setEditingId(null);
    } catch (err) {
      setEditError(err?.message || "Could not save this task.");
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (task) => {
    if (
      !window.confirm(
        `Delete "${task.title}"? This cannot be undone.`
      )
    ) {
      return;
    }
    setSavingId(task.id);
    try {
      await deleteTask(task.id);
    } catch (err) {
      window.alert(err?.message || "Could not delete this task.");
    } finally {
      setSavingId(null);
    }
  };

  const emptyMessage = (() => {
    if (loading) return "Loading tasks...";
    if (error) return "Could not load tasks.";
    if (!isConfigured) return "Not connected. Configure Supabase to load tasks.";
    if (tasks.length === 0) return "No tasks yet. Create your first task below.";
    return "No tasks match your filters.";
  })();

  const activeCount = activeTasks.length;

  return (
    <AppShell currentPath="/tasks">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-col gap-1">
            <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Your planned work. {activeCount} active, {completedCount} completed
              of {totalTasks ?? tasks.length}
              {truncated && totalTasks != null && (
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                  {tasks.length} of {totalTasks} loaded
                </span>
              )}
            </p>
          </div>

          <NewTaskForm onAdd={handleAdd} />

          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            <Queue
              items={queueItems}
              state={taskState}
              error={error || ""}
              busyId={savingId}
              onAction={(task, action) => handleStatusChange(task, action.status)}
            />
            <Plan
              items={planItems}
              state={taskState}
              error={error || ""}
              busyId={savingId}
              onAction={(task, action) => handleStatusChange(task, action.status)}
              description="Tasks that have a due date, soonest first."
              emptyTitle="No dated tasks"
              emptyDetail="A task without a due date stays in the queue."
              showDate
            />
          </div>

          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            <FilterButton
              label="All"
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <FilterButton
              label="Active"
              active={filter === "active"}
              onClick={() => setFilter("active")}
            />
            <FilterButton
              label="Completed"
              active={filter === "completed"}
              onClick={() => setFilter("completed")}
            />
            <FilterButton
              label="Blocked"
              active={filter === "blocked"}
              onClick={() => setFilter("blocked")}
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              <p className="font-semibold">Could not load tasks</p>
              <p className="mt-1">{error}</p>
            </div>
          ) : null}

          {!isConfigured ? (
            <div
              role="status"
              className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <p className="font-semibold">Not connected</p>
              <p className="mt-1">
                Tasks are not persisted. Configure Supabase in your .env file to
                enable storage.
              </p>
            </div>
          ) : null}

          <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-white shadow-sm dark:bg-zinc-900">
            {loading ? (
              <p className="px-4 py-10 text-center text-sm text-gray-500">
                {emptyMessage}
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-gray-500">
                {emptyMessage}
              </p>
            ) : (
              <ul className="space-y-2 p-3 sm:p-4">
                {filtered.map((task) => (
                  <div key={task.id}>
                    {editingId === task.id ? (
                      <EditTaskForm
                        key={task.id}
                        task={task}
                        saving={savingId === task.id}
                        error={editError}
                        onSave={(values) => handleSaveEdit(task, values)}
                        onCancel={() => {
                          setEditingId(null);
                          setEditError("");
                        }}
                      />
                    ) : (
                      <TaskRow
                        task={task}
                        onUpdateStatus={handleStatusChange}
                        onComplete={() => handleStatusChange(task, "completed")}
                        onReopen={() => handleStatusChange(task, "todo")}
                        onEdit={() => {
                          setEditingId(task.id);
                          setEditError("");
                        }}
                        onDelete={() => handleDelete(task)}
                      />
                    )}
                  </div>
                ))}
              </ul>
            )}
          </section>
        </div>
    </AppShell>
  );
}

function FilterButton({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-zinc-800 dark:text-gray-400 dark:hover:bg-zinc-700"
      }`}
    >
      {label}
    </button>
  );
}
