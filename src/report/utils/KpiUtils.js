import { durationSecondsOf, hasRecordedDuration } from "../../dashboard/logUtils";

/**
 * Calculates report KPIs from validated work logs.
 *
 * Missing data is missing, never zero: log entries without a recorded duration
 * are counted separately and excluded from duration totals, so a total never
 * silently mixes "no data" with "zero minutes".
 *
 * Totals are summed from the CANONICAL duration (integer seconds), not from the
 * per-entry rounded minutes, so ten 90-second entries report 15 minutes and not 20.
 *
 * @param {Array} logs - The filtered list of work logs.
 * @returns {Object} KPI values plus data-completeness counters.
 */
export const calculateKPIs = (logs = []) => {
  const list = Array.isArray(logs) ? logs : [];
  const totalLogEntries = list.length;

  const withDuration = list.filter(hasRecordedDuration);

  const totalTimeSeconds = withDuration.reduce(
    (sum, log) => sum + (durationSecondsOf(log) ?? 0),
    0
  );

  const activeDays = [...new Set(withDuration.map((log) => log.date))].length;
  const totalTimeHours = totalTimeSeconds / 3600;
  const avgDailyHours = activeDays > 0 ? totalTimeHours / activeDays : 0;

  return {
    totalTimeLogged: totalTimeHours.toFixed(1),
    totalLogEntries,
    logsMissingDuration: totalLogEntries - withDuration.length,
    avgDailyHours: avgDailyHours.toFixed(1),
    activeDays,
  };
};
