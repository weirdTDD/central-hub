import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { useAuth } from "../../auth/AuthContext";
import { listPreferences, upsertPreferences } from "../../lib/notifications.js";
import { isSupabaseConfigured } from "../../lib/supabase.js";

/**
 * Task reminders use the existing preference row.
 *
 * `kinds.task_alert === false` mutes the inbox entry.
 * `channels.browser === true` asks this browser to show the same reminder.
 * The database channel stays in-app: there is no push service.
 */
export default function TaskAlertSettings() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(true);
  const [browser, setBrowser] = useState(false);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;
    let active = true;
    listPreferences()
      .then((row) => {
        if (!active || !row) return;
        setEnabled(row.kinds?.task_alert !== false);
        setBrowser(row.channels?.browser === true);
      })
      .catch((caught) => {
        if (!active) return;
        setError(caught?.message || "Notification preferences could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (nextEnabled, nextBrowser) => {
    if (!user?.id) {
      setError("You must be signed in.");
      return;
    }
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      let browserOn = nextBrowser;
      if (browserOn) {
        if (typeof Notification === "undefined") {
          setError("This browser cannot show notifications. Reminders still appear in Central Hub.");
          browserOn = false;
        } else {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") {
            setError("The browser did not allow notifications. Reminders still appear in Central Hub.");
            browserOn = false;
          }
        }
      }

      const current = await listPreferences();
      await upsertPreferences({
        userId: user.id,
        timezone: current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        quietHoursStart: current?.quiet_hours_start ?? null,
        quietHoursEnd: current?.quiet_hours_end ?? null,
        channels: { ...(current?.channels ?? { in_app: true }), browser: browserOn },
        kinds: { ...(current?.kinds ?? {}), task_alert: nextEnabled },
      });
      setEnabled(nextEnabled);
      setBrowser(browserOn);
      setSaved(true);
    } catch (caught) {
      setError(caught?.message || "The preference could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-6">
      <h3 className="text-sm font-semibold text-foreground">Task reminders</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Reminders are stored with your tasks and written to the in-app inbox when they are due, including ones that came due while this tab was closed. Quiet hours on the Notifications page hold them back. Browser notifications are this device showing the same inbox item. They are not a push service.
      </p>
      {!isSupabaseConfigured ? (
        <p className="mt-3 text-sm text-muted-foreground">Not connected.</p>
      ) : null}
      {loading ? <p className="mt-3 text-sm text-muted-foreground">Loading reminder preferences…</p> : null}
      {isSupabaseConfigured && !loading ? (
        <div className="mt-3 space-y-3">
          <PreferenceRow
            label="In-app task reminders"
            checked={enabled}
            disabled={saving}
            onChange={(checked) => save(checked, browser)}
          />
          <PreferenceRow
            label="Browser notifications for task reminders"
            checked={browser}
            disabled={saving}
            onChange={(checked) => save(enabled, checked)}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>
      ) : null}
      {saved ? <p className="mt-3 text-sm text-muted-foreground">Saved.</p> : null}
      <Button asChild variant="outline" className="mt-4 min-h-11">
        <Link to="/notifications">Manage reminders</Link>
      </Button>
    </div>
  );
}

function PreferenceRow({ label, checked, disabled, onChange }) {
  return (
    <label className="flex min-h-11 items-center justify-between gap-4 text-sm">
      <span className="text-foreground">{label}</span>
      <input
        type="checkbox"
        className="size-5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
