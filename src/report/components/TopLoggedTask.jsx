import { useMemo } from "react";
import { getTopLoggedTasks } from "../utils/TaskLogged";

const TopLoggedTasks = ({ logs = [] }) => {
  const topTasks = useMemo(() => getTopLoggedTasks(logs), [logs]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card-peach p-3 shadow-sm md:h-64">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-card-foreground">Top Logged Tasks</h3>
      </div>

      <div className="grow space-y-4">
        {topTasks.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">No log data available.</p>
        ) : (
          topTasks.map((task) => (
            <div key={task.id || task.name} className="space-y-2">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="text-sm font-medium text-card-foreground">{task.name}</h4>
                  <p className="text-xs text-muted-foreground">
                    {task.count} log entr{task.count === 1 ? "y" : "ies"}
                    {task.missingDurationCount > 0
                      ? ` · ${task.missingDurationCount} without a recorded duration`
                      : ""}
                  </p>
                </div>
                <span className="text-sm font-semibold text-card-foreground">
                  {task.formattedTime}
                </span>
              </div>

              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-primary h-full rounded-full transition-[width] duration-1000"
                  style={{
                    width: `${Math.min(100, Math.max(0, task.percentage))}%`,
                  }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default TopLoggedTasks;
