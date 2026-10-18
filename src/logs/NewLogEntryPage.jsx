import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLogs } from "../dashboard/LogsContext";
import LogEntryForm from "./LogEntryForm";
import LogEntryLayout from "./LogEntryLayout";

const today = () => new Date().toISOString().slice(0, 10);

export default function NewLogEntryPage() {
  const navigate = useNavigate();
  const { addLog, currentUser } = useLogs();
  const [values, setValues] = useState({
    userName: currentUser.name,
    task: "",
    date: today(),
    timeSpent: "",
    note: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
  });

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!values.task.trim() || !values.date || !values.timeSpent.trim()) return;
    addLog(values);
    navigate("/dashboard");
  };

  return (
    <LogEntryLayout>
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New Log Entry</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Record your daily tasks and progress
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 space-y-8">
        <LogEntryForm values={values} onChange={setValues} showUserName />

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
            Save Entry
          </button>
        </div>
      </form>
    </LogEntryLayout>
  );
}
