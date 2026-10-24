import { Clock3 } from "lucide-react";
import { DateField } from "../components/ui/date-field";

const inputClass =
  "w-full rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20  ";

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
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
        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Date</span>
          <DateField
            value={values.date}
            onChange={(date) => update("date")({ target: { value: date } })}
          />
        </div>
        <Field label="Time Spent">
          <span className="relative block">
            <input
              className={`${inputClass} pr-10`}
              value={values.timeSpent}
              onChange={update("timeSpent")}
              placeholder="e.g. 4h 30m (optional)"
            />
            <Clock3 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </span>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave empty if the time was not recorded — an empty value stays
            &quot;not recorded&quot;, never zero.
          </p>
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
