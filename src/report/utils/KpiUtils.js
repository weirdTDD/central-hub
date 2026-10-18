/**
 * * @param {Array} logs - The filtered list of work logs.
 * @returns {Object} An object containing calculated KPI values and mock trends.
 */
export const calculateKPIs = (logs) => {
  if (logs.length === 0) {
    return {
      totalTimeLogged: "0.0",
      totalTasksCompleted: 0,
      totalTasks: 0,
      avgDailyHours: "0.0",
      trendTime: "0%",
      trendTasks: "0%",
      trendAvg: "0%",
      trendDirection: {
        totalTimeLogged: "up",
        totalTasksCompleted: "up",
        avgDailyHours: "up",
      },
    };
  }

  const totalTimeMinutes = logs.reduce(
    (sum, log) => sum + log.timeSpentMinutes,
    0
  );
  const totalTasks = logs.length;

  const totalTasksCompleted = logs.filter(
    (log) => log.status === "Completed"
  ).length;

  // Calculate Average Daily Hours
  const uniqueDates = [...new Set(logs.map((log) => log.date))].length;
  const totalTimeHours = totalTimeMinutes / 60;
  const avgDailyHours = uniqueDates > 0 ? totalTimeHours / uniqueDates : 0;

  return {
    // KPI 1: Total Time Logged (in hours, rounded to one decimal)
    totalTimeLogged: totalTimeHours.toFixed(1),

    // KPI 2: Task Completed
    totalTasksCompleted: totalTasksCompleted,
    totalTasks: totalTasks,

    // KPI 3: Average Daily Hours (rounded to one decimal)
    avgDailyHours: avgDailyHours.toFixed(1),

    // Mock trend values for visual demo
    trendTime: "12%",
    trendTasks: "4%",
    trendAvg: "0.7%",
    // Mock trend directions
    trendDirection: {
      totalTimeLogged: "up",
      totalTasksCompleted: "down",
      avgDailyHours: "up",
    },
  };
};
