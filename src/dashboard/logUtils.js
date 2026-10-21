export const MISSING_DURATION_LABEL = "Not recorded";

/**
 * True when a log entry carries a recorded duration.
 *
 * Centralised here so every report/chart uses the same rule: a missing duration is
 * missing, never zero. The canonical value is `durationSeconds` (integer seconds);
 * `timeSpentMinutes` is accepted as a fallback for older shapes.
 *
 * @param {object|null|undefined} log
 * @returns {boolean}
 */
export function hasRecordedDuration(log) {
  if (!log) return false;
  if (log.durationSeconds !== null && log.durationSeconds !== undefined) return true;
  return log.timeSpentMinutes !== null && log.timeSpentMinutes !== undefined;
}

/**
 * The canonical duration of a log entry, in integer seconds.
 *
 * @param {object|null|undefined} log
 * @returns {number|null} seconds, or null when the duration was not recorded
 */
export function durationSecondsOf(log) {
  if (!log) return null;
  if (log.durationSeconds !== null && log.durationSeconds !== undefined) {
    return Number(log.durationSeconds);
  }
  if (log.timeSpentMinutes !== null && log.timeSpentMinutes !== undefined) {
    return Number(log.timeSpentMinutes) * 60;
  }
  return null;
}

export function formatDuration(minutes) {
  const safe = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

/**
 * Formats a duration in the canonical unit (integer seconds) for display.
 *
 * The output round-trips through `parseDurationStrict`, so a value shown in the UI
 * can be edited and saved without changing the stored duration.
 *
 * @param {number|null|undefined} seconds
 * @returns {string} e.g. "1h 30m", "2m 30s", "45s"
 */
export function formatDurationFromSeconds(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) {
    return MISSING_DURATION_LABEL;
  }

  const total = Math.max(0, Math.round(Number(seconds)));
  if (total === 0) return "0s";

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0) parts.push(`${secs}s`);
  return parts.join(" ");
}

/**
 * Parses a duration string ("4h 30m", "90m", "2m 30s") into whole seconds.
 * Returns null when the text cannot be parsed — an unparseable value is missing
 * data, never zero.
 *
 * A bare number is read as minutes (the historical convention of this form).
 */
function parseDurationStrict(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === MISSING_DURATION_LABEL) return null;

  const hoursMatch = trimmed.match(/(\d+)\s*h/i);
  const minsMatch = trimmed.match(/(\d+)\s*m/i);
  const secsMatch = trimmed.match(/(\d+)\s*s/i);

  if (hoursMatch || minsMatch || secsMatch) {
    const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
    const mins = minsMatch ? Number(minsMatch[1]) : 0;
    const secs = secsMatch ? Number(secsMatch[1]) : 0;
    return hours * 3600 + mins * 60 + secs;
  }

  // A bare number is treated as minutes.
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) ? Math.round(asNumber) * 60 : null;
}

/**
 * True when the duration text can be understood. Used to reject bad input in the
 * form instead of silently persisting a zero-minute duration.
 */
export function isParseableDuration(value) {
  return parseDurationStrict(value) !== null;
}

/**
 * Converts a duration string ("4h 30m") to the canonical storage unit: integer seconds.
 * Returns null when no duration was recorded — missing data is null, never 0.
 */
export function durationStringToSeconds(value) {
  const seconds = parseDurationStrict(value);
  return seconds === null ? null : seconds;
}

export function formatDisplayDate(isoDate) {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) return isoDate;
  return `${month}-${day}-${year}`;
}

export function downloadCsv(rows, filename = "work-logs.csv") {
  const header = ["Team Member", "Task", "Date", "Time Spent", "Note"];
  const lines = rows.map((log) =>
    [
      log.user?.name ?? "",
      log.task ?? "",
      formatDisplayDate(log.date),
      log.duration ?? "",
      (log.note ?? "").replaceAll('"', '""'),
    ]
      .map((cell) => `"${cell}"`)
      .join(",")
  );

  const blob = new Blob([[header.join(","), ...lines].join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
