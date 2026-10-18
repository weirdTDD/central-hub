import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useLogs } from "../dashboard/LogsContext";
import LogEntryForm from "./LogEntryForm";
import LogEntryLayout from "./LogEntryLayout";

export default function EditLogEntryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { getLog, updateLog, deleteLog } = useLogs();
  const existing = getLog(id);
  const [values, setValues] = useState(() => {
    const log = getLog(id);
    if (!log) return null;
    return {
      task: log.task,
      date: log.date,
      timeSpent: log.duration,
      note: log.note ?? "",
    };
  });

  if (!existing || !values) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!values.task.trim() || !values.date || !values.timeSpent.trim()) return;
    updateLog(id, values);
    navigate("/dashboard");
  };

  const handleDelete = () => {
    deleteLog(id);
    navigate("/dashboard");
  };

  return (
    <LogEntryLayout>
      <nav className="text-sm text-gray-500 dark:text-gray-400">
        <Link to="/dashboard" className="hover:text-[#5B16E1]">
          Dashboard
        </Link>
        <span className="mx-1.5">/</span>
        <span>Log</span>
        <span className="mx-1.5">/</span>
        <span className="text-gray-700 dark:text-gray-200">Edit Log Entry</span>
      </nav>

      <h1 className="mt-3 text-3xl font-bold tracking-tight">Edit Log Entry</h1>

      <form onSubmit={handleSubmit} className="mt-8 space-y-8">
        <LogEntryForm values={values} onChange={setValues} noteLabel="Notes" />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={handleDelete}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
          >
            <Trash2 className="h-4 w-4" />
            Delete Log
          </button>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => navigate("/dashboard")}
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-gray-200 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg bg-[#5B16E1] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4a11c0]"
            >
              Save Changes
            </button>
          </div>
        </div>
      </form>
    </LogEntryLayout>
  );
}
