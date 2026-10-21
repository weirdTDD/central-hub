import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "../../auth/AuthContext";
import { isSupabaseConfigured, supabase } from "../../lib/supabase";
import {
  deleteTask as deleteTaskRow,
  insertTask,
  listTasks,
  updateTask as updateTaskRow,
} from "../../lib/tasks";
import {
  ACTIVE_STATUSES,
  isValidStatusTransition,
  toTaskShape,
} from "./taskUtils";

const TasksContext = createContext(null);

export function TasksProvider({ children }) {
  const { user: authUser, isAuthenticated } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [loadedForUser, setLoadedForUser] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [totalTasks, setTotalTasks] = useState(null);
  const [truncated, setTruncated] = useState(false);

  const ownerId = authUser?.id ?? null;

  const loading =
    isSupabaseConfigured && isAuthenticated && loadedForUser !== ownerId;

  const authUserRef = useRef(authUser);
  useEffect(() => {
    authUserRef.current = authUser;
  });

  useEffect(() => {
    let cancelled = false;

    const request =
      isSupabaseConfigured && isAuthenticated
        ? listTasks()
        : Promise.resolve({ rows: [], total: null, truncated: false });

    request.then(
      (result) => {
        if (cancelled) return;
        setTasks(result.rows.map(toTaskShape));
        setTotalTasks(result.total);
        setTruncated(result.truncated);
        setError(null);
        setLoadedForUser(ownerId);
      },
      (err) => {
        if (cancelled) return;
        setError(err?.message || "Could not load tasks.");
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
      .channel("tasks_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        scheduleReload
      )
      .subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [isAuthenticated]);

  const getTask = useCallback(
    (id) => tasks.find((task) => String(task.id) === String(id)),
    [tasks]
  );

  const addTask = useCallback(
    async ({ title, description, status, priority, dueDate, estimatedSeconds }) => {
      if (!title || !title.trim()) {
        throw new Error("Task title is required.");
      }
      const row = await insertTask({
        title,
        description,
        status: status ?? "todo",
        priority: priority ?? "medium",
        dueDate,
        estimatedSeconds,
      });
      const shaped = toTaskShape(row);
      setTasks((current) => [shaped, ...current]);
      return shaped;
    },
    []
  );

  const updateTask = useCallback(
    async (id, values) => {
      const row = await updateTaskRow(id, values);
      const shaped = toTaskShape(row);
      setTasks((current) =>
        current.map((task) =>
          String(task.id) === String(id) ? shaped : task
        )
      );
      return shaped;
    },
    []
  );

  const deleteTask = useCallback(
    async (id) => {
      await deleteTaskRow(id);
      setTasks((current) => current.filter((task) => String(task.id) !== String(id)));
    },
    []
  );

  /**
   * Validates and persists a status transition, keeping `completed_at` in sync
   * with the state machine (set when a task is completed, cleared when
   * reopened).
   *
   * Transition validation is client-side (there is no app backend); the DB CHECK
   * constraint still rejects unknown statuses, and ownership is enforced by RLS
   * in the database — so this never widens access.
   */
  const transitionTask = useCallback(
    async (id, nextStatus) => {
      const task = getTask(id);
      if (!task) throw new Error("Task not found.");
      if (!isValidStatusTransition(task.status, nextStatus)) {
        throw new Error(
          `Cannot move "${task.title}" from "${task.status}" to "${nextStatus}".`
        );
      }

      const completedAt =
        nextStatus === "completed"
          ? new Date().toISOString()
          : nextStatus === "todo"
            ? null
            : undefined;

      return updateTask(id, {
        status: nextStatus,
        ...(completedAt !== undefined ? { completedAt } : {}),
      });
    },
    [getTask, updateTask]
  );

  const activeTasks = useMemo(
    () => tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)),
    [tasks]
  );

  const completedCount = useMemo(
    () => tasks.filter((t) => t.status === "completed").length,
    [tasks]
  );

  const value = useMemo(
    () => ({
      tasks,
      addTask,
      updateTask,
      deleteTask,
      transitionTask,
      activeTasks,
      completedCount,
      loading,
      error,
      isConfigured: isSupabaseConfigured,
      totalTasks,
      truncated,
    }),
    [
      tasks,
      addTask,
      updateTask,
      deleteTask,
      transitionTask,
      activeTasks,
      completedCount,
      loading,
      error,
      totalTasks,
      truncated,
    ]
  );

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTasks() {
  const context = useContext(TasksContext);
  if (!context) {
    throw new Error("useTasks must be used within TasksProvider");
  }
  return context;
}
