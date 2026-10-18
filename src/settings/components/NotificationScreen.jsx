import { useState } from "react";

const PREFERENCES = [
  {
    id: "email",
    title: "Email Notification",
    description: "Receive alerts in your inbox",
    defaultOn: true,
  },
  {
    id: "push",
    title: "Push Notification",
    description: "Get instant push alerts on your devices",
    defaultOn: true,
  },
  {
    id: "tasks",
    title: "Task Assignment",
    description: "Get notified when a task is assigned to you",
    defaultOn: true,
  },
  {
    id: "summary",
    title: "Daily Summary",
    description: "Receive a daily digest of your completed and pending tasks",
    defaultOn: false,
  },
  {
    id: "updates",
    title: "Product Updates",
    description: "Receive news about new features and improvements",
    defaultOn: true,
  },
];

function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-[#5B16E1]" : "bg-gray-300 dark:bg-zinc-600"
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

export default function NotificationScreen() {
  const [enabled, setEnabled] = useState(() =>
    Object.fromEntries(PREFERENCES.map((item) => [item.id, item.defaultOn]))
  );

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold">Notification Preferences</h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Choose how you want to be notified</p>

      <ul className="mt-4 divide-y divide-gray-100 dark:divide-zinc-800">
        {PREFERENCES.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-4 py-4">
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{item.title}</p>
              <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{item.description}</p>
            </div>
            <Toggle
              label={item.title}
              checked={enabled[item.id]}
              onChange={(next) => setEnabled((current) => ({ ...current, [item.id]: next }))}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
