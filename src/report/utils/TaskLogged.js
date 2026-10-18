/**
 * Groups logs by task name, sums duration, and returns the top 3 tasks.
 * @param {Array} logs - The list of work logs.
 * @returns {Array} Sorted array of top tasks with stats.
 */
export const getTopLoggedTasks = (logs = []) => {
  if (!Array.isArray(logs)) return [];

  // 1. Group and sum time by task name
  const taskMap = logs.reduce((acc, log) => {
    const taskName = log.task || "Unknown Task";
    const minutes = Number(log.timeSpentMinutes) || 0;

    if (!acc[taskName]) {
      acc[taskName] = {
        id: taskName,
        name: taskName,
        totalMinutes: 0,
        count: 0,
      };
    }

    acc[taskName].totalMinutes += minutes;
    acc[taskName].count += 1;

    return acc;
  }, {});

  // 2. Convert to array and sort (non-mutating)
  const sortedTasks = [...Object.values(taskMap)].sort(
    (a, b) => b.totalMinutes - a.totalMinutes
  );

  // 3. Max duration (safe fallback)
  const maxDuration = sortedTasks[0]?.totalMinutes || 1;

  // 4. Return top 3 with formatted values
  return sortedTasks.slice(0, 3).map((task) => {
    const hours = Math.floor(task.totalMinutes / 60);
    const minutes = task.totalMinutes % 60;

    const formattedTime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    const percentage = Math.min(
      100,
      Math.max(0, (task.totalMinutes / maxDuration) * 100)
    );

    return {
      ...task,
      formattedTime,
      percentage,
    };
  });
};
