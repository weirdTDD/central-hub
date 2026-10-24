import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLogs } from "../dashboard/LogsContext";
import { isParseableDuration } from "../dashboard/logUtils";
import { localDayKey } from "../lib/dates";
import LogEntryForm from "./LogEntryForm";
import LogEntryLayout from "./LogEntryLayout";

// The user's LOCAL day — the same day key the rest of the app files logs under.
const today = () => localDayKey(new Date());

export default function NewLogEntryPage() {
  const navigate = useNavigate();
  const { addLog, currentUser } = useLogs();
  const [values, setValues] = useState({
    userName: currentUser.name,
    task: "",
    date: today(),
    timeSpent: "",
    note: "",
  });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    if (!values.task.trim() || !values.date) {
      setError("Task and date are required.");
      return;
    }
    // A duration is optional: an empty field means "not recorded" (missing data,
    // never zero). A non-empty field must be a duration we understand.
    if (values.timeSpent.trim() && !isParseableDuration(values.timeSpent)) {
      setError('Time spent must be a duration such as "4h 30m", "90m" or "1m 30s".');
      return;
    }

    setSaving(true);
    try {
      await addLog(values);
      navigate("/logs");
    } catch (err) {
      setError(err?.message || "Could not save this log entry.");
      setSaving(false);
    }
  };

  return (
    <LogEntryLayout>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Log Entry</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Record your daily tasks and progress
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-8">
        <LogEntryForm values={values} onChange={setValues} showUserName />

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => navigate("/logs")}
            className="rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Entry"}
          </button>
        </div>
      </form>
    </LogEntryLayout>
  );
}
