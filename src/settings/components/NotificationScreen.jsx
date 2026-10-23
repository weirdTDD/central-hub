import { Link } from "react-router-dom";

/**
 * The settings screen for notifications.
 *
 * WHY this screen only points somewhere: the notification preferences, the workflows
 * and the inbox are real records, and they live on the Notifications page. The
 * toggles that used to be here kept their state in the browser and were never
 * saved anywhere, so they were removed rather than left looking operational.
 *
 * The delivery channels are listed with their real state: the in-app channel is
 * connected, the others are not implemented and are labelled as such.
 */
const CHANNELS = [
  {
    id: "in_app",
    label: "In-app",
    state: "Connected",
    connected: true,
    meaning: "Notifications appear in your Sentral Hub inbox.",
  },
  {
    id: "email",
    label: "Email",
    state: "Not connected",
    connected: false,
    meaning: "No email channel is configured, so nothing is sent by email.",
  },
  {
    id: "push",
    label: "Push",
    state: "Not connected",
    connected: false,
    meaning: "No push channel is configured, so nothing is sent to a device.",
  },
];

export default function NotificationScreen() {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <h2 className="text-base font-semibold text-foreground">
        Notification Preferences
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Quiet hours, workflows and the delivery history live on the Notifications
        page, where they are stored for real.
      </p>

      <Link
        to="/notifications"
        className="mt-4 inline-flex items-center rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
      >
        Open Notifications
      </Link>

      <h3 className="mt-6 text-sm font-semibold text-foreground">
        Delivery channels
      </h3>
      <ul className="mt-3 divide-y divide-border">
        {CHANNELS.map((channel) => (
          <li
            key={channel.id}
            className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-sm font-semibold text-foreground">
                {channel.label}
              </p>
              <p className="text-xs text-muted-foreground">
                {channel.meaning}
              </p>
            </div>
            <span
              className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                channel.connected
                  ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {channel.state}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
