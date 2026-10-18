import { createContext, useContext, useMemo, useState } from "react";
import { WORK_LOGS } from "../report/mockData";
import { formatDuration, parseDuration } from "./logUtils";

const LogsContext = createContext(null);

const CURRENT_USER = {
  name: "Kwakye Amoah",
  avatar: "https://i.pravatar.cc/150?u=kwakye",
  role: "Frontend Dev",
};

export function LogsProvider({ children }) {
  const [logs, setLogs] = useState(WORK_LOGS);

  const value = useMemo(() => {
    const getLog = (id) => logs.find((log) => String(log.id) === String(id));

    const addLog = ({ userName, task, date, timeSpent, note }) => {
      const minutes = parseDuration(timeSpent);
      const nextId = logs.reduce((max, log) => Math.max(max, log.id), 0) + 1;
      const entry = {
        id: nextId,
        user: {
          ...CURRENT_USER,
          name: userName?.trim() || CURRENT_USER.name,
        },
        task: task.trim(),
        date,
        duration: formatDuration(minutes),
        timeSpentMinutes: minutes,
        note: note?.trim() || "",
      };
      setLogs((current) => [entry, ...current]);
      return entry;
    };

    const updateLog = (id, { task, date, timeSpent, note }) => {
      const minutes = parseDuration(timeSpent);
      setLogs((current) =>
        current.map((log) =>
          String(log.id) === String(id)
            ? {
                ...log,
                task: task.trim(),
                date,
                duration: formatDuration(minutes),
                timeSpentMinutes: minutes,
                note: note?.trim() || "",
              }
            : log
        )
      );
    };

    const deleteLog = (id) => {
      setLogs((current) => current.filter((log) => String(log.id) !== String(id)));
    };

    return { logs, getLog, addLog, updateLog, deleteLog, currentUser: CURRENT_USER };
  }, [logs]);

  return <LogsContext.Provider value={value}>{children}</LogsContext.Provider>;
}

export function useLogs() {
  const context = useContext(LogsContext);
  if (!context) {
    throw new Error("useLogs must be used within LogsProvider");
  }
  return context;
}
