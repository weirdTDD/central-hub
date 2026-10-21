import { durationSecondsOf, hasRecordedDuration } from "../../dashboard/logUtils";

/**
 * Groups logs by task name, sums duration, and returns the top 3 tasks.
 *
 * A log entry without a recorded duration contributes no time AND is counted
 * separately, so a task whose entries have no duration is reported as "Not
 * recorded" rather than as zero minutes.
 *
 * The sum uses the CANONICAL duration (integer seconds), so rounding only happens
 * at display time.
 *
 * @param {Array} logs - The list of work logs.
 * @returns {Array} Sorted array of top tasks with stats.
 */
export const getTopLoggedTasks = (logs = []) => {
  if (!Array.isArray(logs)) return [];

  // 1. Group and sum time by task name
  const taskMap = logs.reduce((acc, log) => {
    const taskName = log.task || "Unknown Task";
    const hasDuration = hasRecordedDuration(log);
    const seconds = hasDuration ? durationSecondsOf(log) ?? 0 : 0;

    if (!acc[taskName]) {
      acc[taskName] = {
        id: taskName,
        name: taskName,
        totalSeconds: 0,
        count: 0,
        withDurationCount: 0,
        missingDurationCount: 0,
      };
    }

    acc[taskName].totalSeconds += seconds;
    acc[taskName].count += 1;
    if (hasDuration) {
      acc[taskName].withDurationCount += 1;
    } else {
      acc[taskName].missingDurationCount += 1;
    }

    return acc;
  }, {});

  // 2. Convert to array and sort (non-mutating)
  const sortedTasks = [...Object.values(taskMap)].sort(
    (a, b) => b.totalSeconds - a.totalSeconds
  );

  // 3. Max duration (safe fallback)
  const maxDuration = sortedTasks[0]?.totalSeconds || 1;

  // 4. Return top 3 with formatted values
  return sortedTasks.slice(0, 3).map((task) => {
    const hours = Math.floor(task.totalSeconds / 3600);
    const minutes = Math.floor((task.totalSeconds % 3600) / 60);

    // No recorded duration on any of the task's entries: the time is unknown,
    // which is not the same as zero.
    const formattedTime =
      task.withDurationCount === 0
        ? "Not recorded"
        : hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}m`;

    const percentage = Math.min(
      100,
      Math.max(0, (task.totalSeconds / maxDuration) * 100)
    );

    return {
      ...task,
      totalMinutes: Math.round(task.totalSeconds / 60),
      formattedTime,
      percentage,
    };
  });
};
