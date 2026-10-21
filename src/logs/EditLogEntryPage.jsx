import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useLogs } from "../dashboard/LogsContext";
import { isParseableDuration, formatDurationFromSeconds } from "../dashboard/logUtils";
import LogEntryForm from "./LogEntryForm";
import LogEntryLayout from "./LogEntryLayout";

/**
 * The editable form.
 *
 * This is a separate component so it can be mounted with `key={log.id}`: the
 * log arrives asynchronously, and keying on the id re-runs the state
 * initialiser exactly when the data lands (and never with stale data).
 */
function LogEditForm({ log, onSave, onDelete, saving, error }) {
  const navigate = useNavigate();
  const [values, setValues] = useState({
    task: log.task,
    date: log.date ?? "",
    // Seeded from the canonical seconds so an edit never changes the stored
    // duration. A missing duration starts empty, not as a placeholder label.
    timeSpent:
      log.durationSeconds === null || log.durationSeconds === undefined
        ? ""
        : formatDurationFromSeconds(log.durationSeconds),
    note: log.note ?? "",
  });
  const [validationError, setValidationError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setValidationError("");

    if (!values.task.trim() || !values.date) {
      setValidationError("Task and date are required.");
      return;
    }
    // A duration is optional: an empty field means "not recorded" (missing data,
    // never zero). A non-empty field must be a duration we understand.
    if (values.timeSpent.trim() && !isParseableDuration(values.timeSpent)) {
      setValidationError(
        'Time spent must be a duration such as "4h 30m", "90m" or "1m 30s".'
      );
      return;
    }

    await onSave(values);
  };

  return (
    <form onSubmit={handleSubmit} className="mt-8 space-y-8">
      <LogEntryForm values={values} onChange={setValues} noteLabel="Notes" />

      {validationError ? (
        <p role="alert" className="text-sm text-red-600">
          {validationError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          onClick={onDelete}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
        >
          <Trash2 className="h-4 w-4" />
          Delete Log
        </button>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate("/logs")}
            className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </form>
  );
}

export default function EditLogEntryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getLog, updateLog, deleteLog, loading } = useLogs();
  const existing = getLog(id);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Wait for the log to load before deciding that it does not exist.
  if (loading && !existing) {
    return (
      <LogEntryLayout>
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading log entry...</p>
      </LogEntryLayout>
    );
  }

  if (!existing) {
    return <Navigate to="/logs" replace />;
  }

  const handleSave = async (values) => {
    setError("");
    setSaving(true);
    try {
      await updateLog(id, values);
      navigate("/logs");
    } catch (err) {
      setError(err?.message || "Could not save this log entry.");
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setError("");
    setSaving(true);
    try {
      await deleteLog(id);
      navigate("/logs");
    } catch (err) {
      setError(err?.message || "Could not delete this log entry.");
      setSaving(false);
    }
  };

  return (
    <LogEntryLayout>
      <nav className="text-sm text-gray-500 dark:text-gray-400">
          <Link to="/logs" className="hover:text-primary">
          Work logs
        </Link>
        <span className="mx-1.5">/</span>
        <span>Log</span>
        <span className="mx-1.5">/</span>
        <span className="text-gray-700 dark:text-gray-200">Edit Log Entry</span>
      </nav>

      <h1 className="mt-3 text-3xl font-bold tracking-tight">Edit Log Entry</h1>

      <LogEditForm
        key={existing.id}
        log={existing}
        onSave={handleSave}
        onDelete={handleDelete}
        saving={saving}
        error={error}
      />
    </LogEntryLayout>
  );
}
