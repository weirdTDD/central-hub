// Central Hub — the integrations context.
//
// The page shows what is REALLY connected: the state of every connection comes
// from a database row, never from the browser. A failed import is an outcome the
// user has to see, so the actions here never swallow a failure — they return it.
//
// The shape of this provider follows src/features/tasks/TasksContext.jsx: a
// derived `loading`, a load effect with a `cancelled` flag, a realtime
// subscription whose events are coalesced, and a memoized context value.

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
import { listIntegrations, listSyncRuns } from "../../lib/integrations";
import { getAdapter } from "./contract.js";
import { disconnectIntegration, runAdapterSync } from "./syncEngine.js";

const IntegrationsContext = createContext(null);

/** The adapter that reads an activity file the user picks on their own device. */
const ACTIVITY_FILE_ADAPTER_ID = "local_activity_file";

export function IntegrationsProvider({ children }) {
  const { user: authUser, isAuthenticated } = useAuth();
  const [integrations, setIntegrations] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [loadedForUser, setLoadedForUser] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [totalIntegrations, setTotalIntegrations] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [totalSyncRuns, setTotalSyncRuns] = useState(null);
  const [syncRunsTruncated, setSyncRunsTruncated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(null);

  const ownerId = authUser?.id ?? null;

  // Derived rather than stored: avoids writing state from inside an effect.
  const loading =
    isSupabaseConfigured && isAuthenticated && loadedForUser !== ownerId;

  // A load failure and an action failure are different facts, so they are kept
  // apart — but the page has to show both, so `error` is the more recent of the
  // two and `errorScope` says which one it is.
  const error = actionError ?? loadError;
  const errorScope = actionError ? "action" : loadError ? "load" : null;

  useEffect(() => {
    let cancelled = false;

    const empty = { rows: [], total: null, truncated: false };
    const request =
      isSupabaseConfigured && isAuthenticated
        ? Promise.all([listIntegrations(), listSyncRuns()])
        : Promise.resolve([empty, empty]);

    request.then(
      ([integrationResult, runResult]) => {
        if (cancelled) return;
        setIntegrations(integrationResult.rows);
        setTotalIntegrations(integrationResult.total);
        setTruncated(integrationResult.truncated);
        setSyncRuns(runResult.rows);
        setTotalSyncRuns(runResult.total);
        setSyncRunsTruncated(runResult.truncated);
        setLoadError(null);
        setLoadedForUser(ownerId);
      },
      (err) => {
        if (cancelled) return;
        setLoadError(err?.message || "Could not load integrations.");
        setLoadedForUser(ownerId);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [ownerId, isAuthenticated, reloadToken]);

  // Keep the store in sync with writes made in another tab or session.
  useEffect(() => {
    if (!supabase || !isAuthenticated) return undefined;

    // A single write can produce several change events (and the app's own writes
    // arrive back as events). The reload is coalesced so a burst of events costs
    // ONE refetch instead of one per event.
    let timer = null;
    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setReloadToken((token) => token + 1);
      }, 300);
    };

    const integrationsChannel = supabase
      .channel("integrations_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "integrations" },
        scheduleReload
      )
      .subscribe();

    const syncRunsChannel = supabase
      .channel("integration_sync_runs_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "integration_sync_runs" },
        scheduleReload
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(integrationsChannel);
      supabase.removeChannel(syncRunsChannel);
    };
  }, [isAuthenticated]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Imports an activity file through the local-file adapter.
   *
   * The result is RETURNED so the page can show what happened: how many records
   * were seen, written and skipped, or the reason the run failed. A failure is
   * never swallowed — a run that failed comes back as an error result, and an
   * exception (the database being unreachable, for example) is caught, stored
   * and returned the same way.
   *
   * @param {File} file the file the user picked
   * @returns {Promise<{status: string, integration: object|null, recordsSeen: number, recordsWritten: number, recordsSkipped: number, error: string|null}>}
   */
  const syncFromFile = useCallback(async (file) => {
    setActionError(null);
    setSyncing(true);
    setSyncProgress("reading");

    let result;
    try {
      const adapter = getAdapter(ACTIVITY_FILE_ADAPTER_ID);
      if (!adapter) {
        throw new Error("The local activity file adapter is not registered.");
      }

      const text = await file.text();
      result = await runAdapterSync({
        adapter,
        text,
        provider: adapter.id,
        label: adapter.label,
        onProgress: (phase) => setSyncProgress(phase),
      });
    } catch (err) {
      const message =
        err?.message || "The activity file could not be imported.";
      setActionError(message);
      result = {
        status: "error",
        integration: null,
        recordsSeen: 0,
        recordsWritten: 0,
        recordsSkipped: 0,
        error: message,
      };
    } finally {
      setSyncing(false);
      setSyncProgress(null);
      // The run wrote to the database, so the lists have to be read again.
      setReloadToken((token) => token + 1);
    }

    return result;
  }, []);

  /**
   * Syncs a connector that reads this computer.
   *
   * The dev server collects the records. This function never receives a path:
   * it names the connector, and the server decides which folder it may read.
   *
   * @param {import("./contract.js").IntegrationAdapter} adapter
   */
  const syncLocal = useCallback(async (adapter) => {
    setActionError(null);
    setSyncing(true);
    setSyncProgress("reading");

    let result;
    try {
      const response = await fetch("/api/connectors/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: adapter.id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) {
        throw new Error(
          body?.error ||
            "This computer could not be read. Start the app with pnpm dev and try the sync again."
        );
      }

      result = await runAdapterSync({
        adapter,
        text: JSON.stringify(body.payload),
        provider: adapter.id,
        label: adapter.label,
        onProgress: (phase) => setSyncProgress(phase),
      });
    } catch (err) {
      const message = err?.message || "The connector could not sync.";
      setActionError(message);
      result = {
        status: "error",
        integration: null,
        recordsSeen: 0,
        recordsWritten: 0,
        recordsSkipped: 0,
        error: message,
      };
    } finally {
      setSyncing(false);
      setSyncProgress(null);
      setReloadToken((token) => token + 1);
    }

    return result;
  }, []);

  /**
   * Removes a connection. The database removes the observations that connection
   * imported along with it.
   *
   * @param {object} integration the connection row
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  const disconnect = useCallback(async (integration) => {
    setActionError(null);
    try {
      const result = await disconnectIntegration(integration);
      setReloadToken((token) => token + 1);
      return result;
    } catch (err) {
      const message =
        err?.message || "The integration could not be disconnected.";
      setActionError(message);
      return { ok: false, error: message };
    }
  }, []);

  const value = useMemo(
    () => ({
      integrations,
      syncRuns,
      loading,
      error,
      errorScope,
      isConfigured: isSupabaseConfigured,
      totalIntegrations,
      truncated,
      totalSyncRuns,
      syncRunsTruncated,
      syncing,
      syncProgress,
      syncFromFile,
      syncLocal,
      disconnect,
      refresh,
    }),
    [
      integrations,
      syncRuns,
      loading,
      error,
      errorScope,
      totalIntegrations,
      truncated,
      totalSyncRuns,
      syncRunsTruncated,
      syncing,
      syncProgress,
      syncFromFile,
      syncLocal,
      disconnect,
      refresh,
    ]
  );

  return (
    <IntegrationsContext.Provider value={value}>
      {children}
    </IntegrationsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useIntegrations() {
  const context = useContext(IntegrationsContext);
  if (!context) {
    throw new Error("useIntegrations must be used within IntegrationsProvider");
  }
  return context;
}
