// Sentral Hub — the time-tracking context.
//
// The page shows what the database REALLY holds: a session is a recorded
// interval, its attribution is explicit, and a correction lives BESIDE the
// session instead of overwriting it. A failed action is an outcome the user has
// to see, so the actions here never throw out of the provider — they return a
// result the page can render.
//
// The shape of this provider follows src/features/tasks/TasksContext.jsx: a
// derived `loading`, a load effect with a `cancelled` flag, a realtime
// subscription whose events are coalesced, and a memoized context value.
//
// A LOAD failure and an ACTION failure are different facts, so they are kept
// apart: `error` says the lists could not be read, `actionError` says the last
// write failed. A failed save is never shown as "Could not load".

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "../../auth/AuthContext";
import { systemTimeZone } from "../../lib/dates";
import {
  SUPABASE_NOT_CONFIGURED_MESSAGE,
  isSupabaseConfigured,
  supabase,
} from "../../lib/supabase";
import { listTaskReferences } from "../../lib/tasks";
import {
  deleteSession,
  insertSession,
  insertSessionCorrection,
  listRecentCorrections,
  listSessions,
  updateSessionAttribution,
} from "../../lib/tracking";
import { buildManualSession, toSessionShape } from "./sessionUtils";

const TrackingContext = createContext(null);

/**
 * Maps a task reference row to the shape the UI consumes.
 *
 * The row carries the task's PLAN: `estimatedSeconds` is the estimate in whole
 * seconds, and `null` when the task has NO estimate ("not estimated"). A missing
 * estimate is never turned into 0 — a zero-second plan and a missing plan are
 * different facts, and the planned-vs-actual view needs to tell them apart.
 *
 * @param {object} row
 * @returns {{id:string, title:string, status:string, estimatedSeconds:number|null, dueDate:string|null, completedAt:string|null}}
 */
function toTaskReferenceShape(row) {
  const estimate =
    row?.estimatedSeconds ??
    row?.estimated_duration_seconds ??
    row?.estimatedDurationSeconds ??
    null;
  return {
    id: row?.id,
    title: row?.title,
    status: row?.status,
    estimatedSeconds:
      estimate === null || estimate === undefined ? null : Number(estimate),
    dueDate: row?.dueDate ?? row?.due_date ?? null,
    completedAt: row?.completedAt ?? row?.completed_at ?? null,
  };
}

export function TrackingProvider({ children }) {
  const { user: authUser, isAuthenticated } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [corrections, setCorrections] = useState([]);
  const [taskReferences, setTaskReferences] = useState([]);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [loadedForUser, setLoadedForUser] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [totalSessions, setTotalSessions] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [totalCorrections, setTotalCorrections] = useState(null);
  const [correctionsTruncated, setCorrectionsTruncated] = useState(false);
  const [busy, setBusy] = useState(false);

  const ownerId = authUser?.id ?? null;

  // Derived rather than stored: avoids writing state from inside an effect.
  const loading =
    isSupabaseConfigured && isAuthenticated && loadedForUser !== ownerId;

  useEffect(() => {
    let cancelled = false;

    const empty = { rows: [], total: null, truncated: false };
    const request =
      isSupabaseConfigured && isAuthenticated
        ? Promise.all([
            listSessions(),
            listRecentCorrections(),
            listTaskReferences(),
          ])
        : Promise.resolve([empty, empty, empty]);

    request.then(
      ([sessionResult, correctionResult, taskResult]) => {
        if (cancelled) return;
        setSessions(sessionResult.rows.map(toSessionShape));
        setTotalSessions(sessionResult.total);
        setTruncated(sessionResult.truncated);
        setCorrections(correctionResult.rows);
        setTotalCorrections(correctionResult.total);
        setCorrectionsTruncated(correctionResult.truncated);
        setTaskReferences(taskResult.rows.map(toTaskReferenceShape));
        setError(null);
        setLoadedForUser(ownerId);
      },
      (err) => {
        if (cancelled) return;
        setError(err?.message || "Could not load sessions.");
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

    const sessionsChannel = supabase
      .channel("sessions_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions" },
        scheduleReload
      )
      .subscribe();

    const correctionsChannel = supabase
      .channel("session_corrections_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "session_corrections" },
        scheduleReload
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(sessionsChannel);
      supabase.removeChannel(correctionsChannel);
    };
  }, [isAuthenticated]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  /**
   * Refuses a write when there is no database to write to.
   *
   * WHY: without a configured project the data layer cannot even be called, and
   * the failure it raises is a low-level one. The user gets the same sentence
   * the rest of the app uses for an unconfigured project.
   *
   * @returns {string|null} the refusal message, or null when the write may go on
   */
  const refuseWhenUnconfigured = useCallback(() => {
    if (isSupabaseConfigured) return null;
    setActionError(SUPABASE_NOT_CONFIGURED_MESSAGE);
    return SUPABASE_NOT_CONFIGURED_MESSAGE;
  }, []);

  /**
   * Records a hand-entered session.
   *
   * The pure rules live in `buildManualSession`: a manual entry carries no
   * observations (nothing was observed) and no idle measurement (idle was never
   * measured), and a task the user picked is a CONFIRMED attribution. The shape
   * it returns is exactly what `insertSession` takes.
   *
   * @param {object} values
   * @param {string} values.startedAt the start, read in the user's local time
   * @param {number} values.durationSeconds whole seconds
   * @param {string|null} [values.taskId]
   * @param {string|null} [values.application]
   * @returns {Promise<{ok: boolean, session?: object, error?: string}>}
   */
  const addManualSession = useCallback(
    async ({ startedAt, durationSeconds, taskId, application }) => {
      setActionError(null);
      const refusal = refuseWhenUnconfigured();
      if (refusal) return { ok: false, error: refusal };
      setBusy(true);
      try {
        const manual = buildManualSession({
          startedAt,
          durationSeconds,
          timezone: systemTimeZone(),
          taskId: taskId || null,
          application: application || null,
        });
        const row = await insertSession({ ...manual });
        setReloadToken((token) => token + 1);
        return { ok: true, session: toSessionShape(row) };
      } catch (err) {
        const message = err?.message || "The session could not be saved.";
        setActionError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [refuseWhenUnconfigured]
  );

  /**
   * Attributes a session to a task, or takes the attribution away again.
   *
   * A manual attribution is a confirmed fact (source "manual", confidence 1);
   * clearing it returns the session to "Unattributed". The app never invents a
   * task relationship.
   *
   * @param {object} session the session row
   * @param {string|null} taskId the task, or null to clear the attribution
   * @returns {Promise<{ok: boolean, session?: object, error?: string}>}
   */
  const attributeSession = useCallback(async (session, taskId) => {
    setActionError(null);
    const refusal = refuseWhenUnconfigured();
    if (refusal) return { ok: false, error: refusal };
    setBusy(true);
    try {
      const row = taskId
        ? await updateSessionAttribution(session.id, {
            taskId,
            attributionSource: "manual",
            attributionConfidence: 1,
          })
        : await updateSessionAttribution(session.id, {
            taskId: null,
            attributionSource: null,
            attributionConfidence: null,
          });
      setReloadToken((token) => token + 1);
      return { ok: true, session: toSessionShape(row) };
    } catch (err) {
      const message = err?.message || "The attribution could not be saved.";
      setActionError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(false);
    }
  }, [refuseWhenUnconfigured]);

  /**
   * Records a correction as its OWN row.
   *
   * The observed values of the session are never overwritten — the correction
   * travels beside it, so the original stays auditable. The corrected duration
   * is computed from the corrected interval, because the database requires the
   * two to agree and would reject a duration that contradicts its own range.
   *
   * @param {object} session the session row (the OBSERVED values)
   * @param {object} values
   * @param {string} values.correctedStartedAt
   * @param {string} values.correctedEndedAt
   * @param {string} [values.reason]
   * @returns {Promise<{ok: boolean, correction?: object, error?: string}>}
   */
  const correctSession = useCallback(
    async (session, { correctedStartedAt, correctedEndedAt, reason }) => {
      setActionError(null);
      const refusal = refuseWhenUnconfigured();
      if (refusal) return { ok: false, error: refusal };
      setBusy(true);
      try {
        const start = Date.parse(correctedStartedAt);
        const end = Date.parse(correctedEndedAt);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          throw new Error("A correction needs a valid start and end time.");
        }
        if (end < start) {
          throw new Error(
            "The corrected end time must not be before the corrected start time."
          );
        }

        const correctedDurationSeconds = Math.round((end - start) / 1000);
        const row = await insertSessionCorrection({
          sessionId: session.id,
          previousStartedAt: session.startedAt ?? null,
          previousEndedAt: session.endedAt ?? null,
          previousDurationSeconds: session.durationSeconds ?? null,
          correctedStartedAt: new Date(start).toISOString(),
          correctedEndedAt: new Date(end).toISOString(),
          correctedDurationSeconds,
          reason: reason && reason.trim() ? reason.trim() : null,
        });
        setReloadToken((token) => token + 1);
        return { ok: true, correction: row };
      } catch (err) {
        const message = err?.message || "The correction could not be saved.";
        setActionError(message);
        return { ok: false, error: message };
      } finally {
        setBusy(false);
      }
    },
    [refuseWhenUnconfigured]
  );

  /**
   * Removes a session. The database removes its corrections with it.
   *
   * @param {object} session
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  const removeSession = useCallback(async (session) => {
    setActionError(null);
    const refusal = refuseWhenUnconfigured();
    if (refusal) return { ok: false, error: refusal };
    setBusy(true);
    try {
      await deleteSession(session.id);
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (err) {
      const message = err?.message || "The session could not be deleted.";
      setActionError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(false);
    }
  }, [refuseWhenUnconfigured]);

  const value = useMemo(
    () => ({
      sessions,
      corrections,
      taskReferences,
      loading,
      error,
      actionError,
      isConfigured: isSupabaseConfigured,
      totalSessions,
      truncated,
      totalCorrections,
      correctionsTruncated,
      busy,
      addManualSession,
      attributeSession,
      correctSession,
      removeSession,
      refresh,
    }),
    [
      sessions,
      corrections,
      taskReferences,
      loading,
      error,
      actionError,
      totalSessions,
      truncated,
      totalCorrections,
      correctionsTruncated,
      busy,
      addManualSession,
      attributeSession,
      correctSession,
      removeSession,
      refresh,
    ]
  );

  return (
    <TrackingContext.Provider value={value}>{children}</TrackingContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTracking() {
  const context = useContext(TrackingContext);
  if (!context) {
    throw new Error("useTracking must be used within TrackingProvider");
  }
  return context;
}
