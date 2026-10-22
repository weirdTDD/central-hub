import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAuth } from "../../auth/AuthContext";
import { isSupabaseConfigured } from "../../lib/supabase.js";
import {
  listHeldTaskAlertNotifications,
  listScheduledAlerts,
  updateTaskAlert,
} from "../../lib/grok.js";
import { insertNotification, listPreferences, updateNotification } from "../../lib/notifications.js";
import { deliverDueAlerts } from "./alerts.js";
import { AlertRevisionContext } from "./alertRevision.js";
import GrokChat from "./GrokChat.jsx";

/**
 * The chat panel and the reminder runner, on every signed-in page.
 *
 * Reminders are rows. This checks them when the app loads, when the tab
 * becomes visible, and every 30 seconds while it is open. A due reminder
 * becomes an inbox notification. A browser notification is shown only when
 * the owner has allowed it.
 */
export default function GrokShell({ children }) {
  const { isAuthenticated } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [panelChat, setPanelChat] = useState(null);
  const [revision, setRevision] = useState(0);
  const [runnerError, setRunnerError] = useState("");
  const [live, setLive] = useState([]);

  const dismiss = useCallback(async (item) => {
    setLive((current) => current.filter((entry) => entry.id !== item.id));
    if (!item?.id || !isSupabaseConfigured) return;
    try {
      await updateNotification(item.id, {
        status: "acknowledged",
        acknowledgedAt: new Date().toISOString(),
      });
    } catch {
      // The inbox row is still there if this write failed.
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !isSupabaseConfigured) return undefined;
    let active = true;

    const tick = async () => {
      try {
        const [alerts, held, preferences] = await Promise.all([
          listScheduledAlerts(),
          listHeldTaskAlertNotifications(),
          listPreferences(),
        ]);
        if (!active) return;
        const surfaced = await deliverDueAlerts({
          alerts,
          held,
          now: new Date(),
          preferences,
          writeNotification: (notification) => insertNotification(notification),
          updateAlert: (id, patch) => updateTaskAlert(id, patch),
          updateNotification: (id, patch) =>
            updateNotification(id, {
              status: patch.status,
              sentAt: patch.sentAt,
              deliveredAt: patch.deliveredAt,
              snoozedUntil: patch.snoozedUntil,
            }),
          browserNotify: showBrowserNotification,
        });
        if (!active) return;
        setRunnerError("");
        if (surfaced.length > 0) {
          setLive((current) => {
            const ids = new Set(current.map((entry) => entry.id));
            const added = surfaced.filter((entry) => entry?.id && !ids.has(entry.id));
            return [...added, ...current].slice(0, 3);
          });
          setRevision((value) => value + 1);
        }
      } catch (caught) {
        if (!active) return;
        setRunnerError(caught?.message || "Reminders could not be checked.");
      }
    };

    tick();
    const timer = window.setInterval(tick, 30000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isAuthenticated]);

  const value = useMemo(
    () => ({ revision, runnerError, live, dismiss }),
    [revision, runnerError, live, dismiss]
  );

  const showLauncher = isAuthenticated && pathname !== "/login" && pathname !== "/grok";

  return (
    <AlertRevisionContext.Provider value={value}>
      {children}
      {live.length > 0 ? (
        <div className="fixed top-4 right-4 z-40 flex w-[min(100vw-2rem,22rem)] flex-col gap-2">
          {live.map((item) => (
            <div
              key={item.id}
              role="status"
              className="rounded-2xl border border-border bg-card p-4 shadow-lg"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">{item.title}</p>
                  {item.body ? <p className="mt-1 text-sm text-muted-foreground">{item.body}</p> : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="min-h-11 min-w-11"
                  aria-label="Dismiss reminder"
                  onClick={() => dismiss(item)}
                >
                  <X />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {showLauncher ? (
        <Button
          type="button"
          className="fixed right-4 bottom-4 z-40 min-h-11 shadow-lg"
          onClick={() => setOpen(true)}
        >
          <Sparkles aria-hidden="true" />
          Grok
        </Button>
      ) : null}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md data-[side=right]:sm:max-w-md"
        >
          <SheetHeader>
            <SheetTitle>Grok</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4">
            <GrokChat
              conversationId={panelChat}
              onConversationId={setPanelChat}
              className="h-[calc(100dvh-7rem)]"
            />
          </div>
        </SheetContent>
      </Sheet>
    </AlertRevisionContext.Provider>
  );
}

function showBrowserNotification(notification) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const item = new Notification(notification.title || "Reminder", {
      body: notification.body || "",
      tag: notification.id,
    });
    item.onclick = () => {
      window.focus();
      window.location.assign("/notifications");
    };
  } catch {
    // The inbox row was already written. A blocked notification API is not a failed reminder.
  }
}
