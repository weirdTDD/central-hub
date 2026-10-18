import { CalendarDays, Clock3 } from "lucide-react";

const inputClass =
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 outline-none transition focus:border-[#5B16E1] focus:ring-2 focus:ring-[#5B16E1]/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-gray-100";

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-gray-500 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}

export default function LogEntryForm({
  values,
  onChange,
  showUserName = false,
  noteLabel = "Note",
}) {
  const update = (key) => (event) => onChange({ ...values, [key]: event.target.value });

  return (
    <div className="space-y-4">
      {showUserName ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Enter User Name">
            <input className={inputClass} value={values.userName} onChange={update("userName")} />
          </Field>
          <Field label="Task Worked On">
            <input
              className={inputClass}
              value={values.task}
              onChange={update("task")}
              placeholder="Task Worked On"
              required
            />
          </Field>
        </div>
      ) : (
        <Field label="Task">
          <input className={inputClass} value={values.task} onChange={update("task")} required />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date">
          <span className="relative block">
            <input
              type="date"
              className={`${inputClass} pr-10`}
              value={values.date}
              onChange={update("date")}
              required
            />
            <CalendarDays className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          </span>
        </Field>
        <Field label="Time Spent">
          <span className="relative block">
            <input
              className={`${inputClass} pr-10`}
              value={values.timeSpent}
              onChange={update("timeSpent")}
              placeholder="e.g. 4h 30m"
              required
            />
            <Clock3 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          </span>
        </Field>
      </div>

      <Field label={noteLabel}>
        <textarea
          rows={5}
          className={`${inputClass} resize-none`}
          value={values.note}
          onChange={update("note")}
          placeholder="Add a note about this log"
        />
      </Field>
    </div>
  );
}
