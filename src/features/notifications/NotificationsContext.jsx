// Central Hub — the notifications context.
//
// Everything on this page comes from the database: a notification exists because a
// workflow actually delivered it, and a workflow shows its real next occurrence.
// Nothing here invents a delivery, a schedule or a state.
//
// The shape of this provider follows src/features/tasks/TasksContext.jsx: a derived
// `loading`, a load effect with a `cancelled` flag, a realtime subscription whose
// events are coalesced, and a memoized context value.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "../../auth/AuthContext";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import {
  deleteNotification,
  insertWorkflow,
  listApprovals,
  listNotifications,
  listPreferences,
  listWorkflowRuns,
  listWorkflows,
  updateApproval,
  updateNotification,
  updateWorkflow,
  upsertPreferences,
} from "../../lib/notifications";
import { nextRunAt, EVENT_TYPES } from "./workflowEngine.js";

const NotificationsContext = createContext(null);

export function NotificationsProvider({ children }) {
  const { user: authUser, isAuthenticated } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [runs, setRuns] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [preferences, setPreferences] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [loadedForUser, setLoadedForUser] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);

  const ownerId = authUser?.id ?? null;

  const loading =
    isSupabaseConfigured && isAuthenticated && loadedForUser !== ownerId;

  // A load failure and an action failure are different facts, so they are kept
  // apart — but the page has to show both.
  const error = actionError ?? loadError;
  const errorScope = actionError ? "action" : loadError ? "load" : null;

  useEffect(() => {
    let cancelled = false;

    const empty = { rows: [], total: null, truncated: false };
    const request =
      isSupabaseConfigured && isAuthenticated
        ? Promise.all([
            listNotifications(),
            listWorkflows(),
            listWorkflowRuns(),
            listApprovals(),
            listPreferences(),
          ])
        : Promise.resolve([empty, empty, empty, empty, null]);

    request.then(
      ([notificationResult, workflowResult, runResult, approvalResult, preferencesRow]) => {
        if (cancelled) return;
        setNotifications(notificationResult.rows);
        setWorkflows(workflowResult.rows);
        setRuns(runResult.rows);
        setApprovals(approvalResult.rows);
        setPreferences(preferencesRow);
        setTruncated(
          notificationResult.truncated ||
            workflowResult.truncated ||
            runResult.truncated ||
            approvalResult.truncated
        );
        setLoadError(null);
        setLoadedForUser(ownerId);
      },
      (err) => {
        if (cancelled) return;
        setLoadError(err?.message || "Could not load the notifications.");
        setLoadedForUser(ownerId);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [ownerId, isAuthenticated, reloadToken]);

  // Keep the store in sync with writes made in another tab or by the worker.
  useEffect(() => {
    if (!supabase || !isAuthenticated) return undefined;

    let timer = null;
    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setReloadToken((token) => token + 1);
      }, 300);
    };

    const channels = ["notifications", "workflows", "workflow_runs", "approvals"].map(
      (table) =>
        supabase
          .channel(`${table}_changes`)
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table },
            scheduleReload
          )
          .subscribe()
    );

    return () => {
      if (timer) clearTimeout(timer);
      for (const channel of channels) supabase.removeChannel(channel);
    };
  }, [isAuthenticated]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Acknowledges a notification: the user has seen it and acted on it.
   */
  const acknowledge = useCallback(async (notification) => {
    setActionError(null);
    try {
      const row = await updateNotification(notification.id, {
        status: "acknowledged",
        acknowledgedAt: new Date().toISOString(),
      });
      setNotifications((current) =>
        current.map((item) => (item.id === row.id ? row : item))
      );
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The notification could not be acknowledged.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, []);

  /**
   * Snoozes a notification until a given moment. The row stays and the snooze is
   * visible — nothing is hidden.
   */
  const snooze = useCallback(async (notification, until) => {
    setActionError(null);
    try {
      const row = await updateNotification(notification.id, {
        snoozedUntil: new Date(until).toISOString(),
      });
      setNotifications((current) =>
        current.map((item) => (item.id === row.id ? row : item))
      );
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The notification could not be snoozed.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, []);

  /**
   * Deletes a notification (the user's right to remove what they were told).
   */
  const remove = useCallback(async (notification) => {
    setActionError(null);
    try {
      await deleteNotification(notification.id);
      setNotifications((current) =>
        current.filter((item) => item.id !== notification.id)
      );
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The notification could not be deleted.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, []);

  /**
   * Creates a workflow and plans its first occurrence.
   *
   * A clock workflow gets its first occurrence; an event workflow gets a CURSOR of
   * "now", so it reacts to what happens from now on and not to everything that
   * happened before it existed.
   */
  const createWorkflow = useCallback(async (values) => {
    setActionError(null);
    setBusy(true);
    try {
      const isEvent = EVENT_TYPES.includes(values.kind);

      const triggerConfig = isEvent
        ? { kind: values.kind, timezone: values.timezone ?? "UTC" }
        : {
            kind: values.kind,
            at: values.at,
            weekdays: values.weekdays ?? [],
            everyMinutes: values.everyMinutes ?? null,
            timezone: values.timezone ?? "UTC",
          };

      const now = new Date();
      const next = isEvent
        ? null
        : nextRunAt(triggerConfig, now, triggerConfig.timezone);

      const row = await insertWorkflow({
        name: values.name,
        description: values.description ?? null,
        triggerType: isEvent ? "event" : "schedule",
        triggerConfig,
        conditions: values.conditions ?? [],
        actionType: "create_notification",
        actionConfig: {
          kind: values.kindName ?? "workflow",
          title: values.title ?? values.name,
          body: values.body ?? null,
        },
        channel: "in_app",
        enabled: true,
        requiresApproval: values.requiresApproval ?? false,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        nextRunAt: next,
        eventCursor: isEvent ? now.toISOString() : null,
      });

      setWorkflows((current) => [row, ...current]);
      return { ok: true, row };
    } catch (err) {
      const message = err?.message || "The workflow could not be created.";
      setActionError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Switches a workflow on or off, and re-plans what it needs.
   *
   * A clock workflow gets a fresh next occurrence; an event workflow gets a fresh
   * CURSOR, so the events that happened while it was switched off are not delivered
   * in a burst when it comes back.
   */
  const setWorkflowEnabled = useCallback(async (workflow, enabled) => {
    setActionError(null);
    try {
      const isEvent = workflow.trigger_type === "event";
      const now = new Date();

      const next = enabled && !isEvent
        ? nextRunAt(
            workflow.trigger_config,
            now,
            workflow.trigger_config?.timezone ?? "UTC"
          )
        : null;

      const row = await updateWorkflow(workflow.id, {
        enabled,
        nextRunAt: next,
        ...(isEvent ? { eventCursor: now.toISOString() } : {}),
      });

      setWorkflows((current) =>
        current.map((item) => (item.id === row.id ? row : item))
      );
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The workflow could not be changed.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, []);

  /**
   * Records a decision on an approval request. The workflow is only performed by
   * the worker AFTER an approval.
   */
  const decideApproval = useCallback(async (approval, decision) => {
    setActionError(null);
    try {
      const row = await updateApproval(approval.id, {
        status: decision,
        decidedAt: new Date().toISOString(),
      });
      setApprovals((current) =>
        current.map((item) => (item.id === row.id ? row : item))
      );
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The approval could not be recorded.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, []);

  /**
   * Saves the delivery preferences (timezone and quiet hours).
   */
  const savePreferences = useCallback(async (values) => {
    setActionError(null);
    try {
      const row = await upsertPreferences({
        userId: ownerId,
        timezone: values.timezone,
        quietHoursStart: values.quietHoursStart || null,
        quietHoursEnd: values.quietHoursEnd || null,
        channels: { in_app: true },
        kinds: values.kinds ?? {},
      });
      setPreferences(row);
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The preferences could not be saved.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, [ownerId]);

  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === "pending"),
    [approvals]
  );

  const value = useMemo(
    () => ({
      notifications,
      workflows,
      runs,
      approvals,
      pendingApprovals,
      preferences,
      loading,
      error,
      errorScope,
      isConfigured: isSupabaseConfigured,
      truncated,
      busy,
      acknowledge,
      snooze,
      remove,
      createWorkflow,
      setWorkflowEnabled,
      decideApproval,
      savePreferences,
      refresh,
    }),
    [
      notifications,
      workflows,
      runs,
      approvals,
      pendingApprovals,
      preferences,
      loading,
      error,
      errorScope,
      truncated,
      busy,
      acknowledge,
      snooze,
      remove,
      createWorkflow,
      setWorkflowEnabled,
      decideApproval,
      savePreferences,
      refresh,
    ]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error("useNotifications must be used within NotificationsProvider");
  }
  return context;
}
