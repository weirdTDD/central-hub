import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "../auth/AuthContext";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import {
  deleteLogRow,
  insertLog,
  listLogs,
  updateLogRow,
} from "../lib/logs";
import {
  MISSING_DURATION_LABEL,
  durationStringToSeconds,
  formatDurationFromSeconds,
} from "./logUtils";
import { avatarFor } from "../lib/avatar";
import { localDayKey } from "../lib/dates";

const LogsContext = createContext(null);

/**
 * Maps a database row to the shape the UI consumes.
 *
 * `duration_seconds` is the single source of truth for duration and travels through
 * the shape UNCHANGED, so totals are summed from the canonical value. A row with no
 * recorded duration yields `durationSeconds: null` (missing), never 0.
 */
function toLogShape(row, authUser) {
  const hasDuration = row.duration_seconds != null;
  const seconds = hasDuration ? Number(row.duration_seconds) : null;
  const fallbackDate = row.created_at ? localDayKey(new Date(row.created_at)) : null;

  const ownerName =
    row.display_name ||
    authUser?.user_metadata?.full_name ||
    authUser?.email ||
    "You";

  return {
    id: row.id,
    user: {
      name: ownerName,
      avatar: avatarFor(authUser),
      role: "Owner",
    },
    task: row.title ?? "",
    date: row.log_date ?? fallbackDate,
    duration: hasDuration ? formatDurationFromSeconds(seconds) : MISSING_DURATION_LABEL,
    durationSeconds: seconds,
    timeSpentMinutes: hasDuration ? Math.round(seconds / 60) : null,
    note: row.notes ?? "",
  };
}

export function LogsProvider({ children }) {
  const { user: authUser, isAuthenticated } = useAuth();
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [loadedForUser, setLoadedForUser] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [totalLogs, setTotalLogs] = useState(null);
  const [truncated, setTruncated] = useState(false);

  const ownerId = authUser?.id ?? null;

  // Derived rather than stored: avoids writing state from inside an effect.
  const loading =
    isSupabaseConfigured && isAuthenticated && loadedForUser !== ownerId;

  const authUserRef = useRef(authUser);
  useEffect(() => {
    authUserRef.current = authUser;
  });

  const currentUser = useMemo(
    () => ({
      name:
        authUser?.user_metadata?.full_name || authUser?.email || "You",
      avatar: avatarFor(authUser),
      role: "Owner",
    }),
    [authUser]
  );

  useEffect(() => {
    let cancelled = false;

    const request =
      isSupabaseConfigured && isAuthenticated
        ? listLogs()
        : Promise.resolve({ rows: [], total: null, truncated: false });

    request.then(
      (result) => {
        if (cancelled) return;
        setLogs(result.rows.map((row) => toLogShape(row, authUserRef.current)));
        setTotalLogs(result.total);
        setTruncated(result.truncated);
        setError(null);
        setLoadedForUser(ownerId);
      },
      (err) => {
        if (cancelled) return;
        setError(err?.message || "Could not load work logs.");
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

    const channel = supabase
      .channel("work_logs_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_logs" },
        scheduleReload
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [isAuthenticated]);

  const getLog = useCallback(
    (id) => logs.find((log) => String(log.id) === String(id)),
    [logs]
  );

  const addLog = useCallback(
    async ({ userName, task, date, timeSpent, note }) => {
      const row = await insertLog({
        title: task.trim(),
        notes: note?.trim() || null,
        logDate: date || null,
        durationSeconds: durationStringToSeconds(timeSpent),
        displayName: userName?.trim() || currentUser.name,
      });
      const shaped = toLogShape(row, authUser);
      setLogs((current) => [shaped, ...current]);
      return shaped;
    },
    [authUser, currentUser.name]
  );

  const updateLog = useCallback(
    async (id, { task, date, timeSpent, note }) => {
      const row = await updateLogRow(id, {
        title: task.trim(),
        notes: note?.trim() || null,
        logDate: date || null,
        durationSeconds: durationStringToSeconds(timeSpent),
      });
      setLogs((current) =>
        current.map((log) =>
          String(log.id) === String(id) ? toLogShape(row, authUser) : log
        )
      );
      return row;
    },
    [authUser]
  );

  const deleteLog = useCallback(async (id) => {
    await deleteLogRow(id);
    setLogs((current) => current.filter((log) => String(log.id) !== String(id)));
  }, []);

  const value = useMemo(
    () => ({
      logs,
      getLog,
      addLog,
      updateLog,
      deleteLog,
      currentUser,
      loading,
      error,
      isConfigured: isSupabaseConfigured,
      totalLogs,
      truncated,
    }),
    [
      logs,
      getLog,
      addLog,
      updateLog,
      deleteLog,
      currentUser,
      loading,
      error,
      totalLogs,
      truncated,
    ]
  );

  return <LogsContext.Provider value={value}>{children}</LogsContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLogs() {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useLogs must be used within LogsProvider");
  }
  return context;
}
