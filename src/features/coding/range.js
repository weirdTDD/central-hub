// Local-day bounds for coding heartbeats.
//
// A heartbeat belongs to the local day of its occurrence time. The end bound is
// exclusive, so a heartbeat that starts at the next midnight is the next day.

import { addDays, civilToInstant } from "../../dashboard/todayView.js";

/**
 * Inclusive start and exclusive end of one local calendar day, as ISO timestamps.
 *
 * @param {string} dayKey 'YYYY-MM-DD'
 * @param {string} timeZone IANA zone
 * @returns {{from: string, to: string}|null}
 */
export function localDayRange(dayKey, timeZone) {
  const from = civilToInstant(dayKey, "00:00", timeZone);
  const next = addDays(dayKey, 1);
  const to = next ? civilToInstant(next, "00:00", timeZone) : null;
  if (!from || !to) return null;
  return { from, to };
}

/**
 * The report's range, with the last day included.
 *
 * The report's `to` is the start of the last selected day, and its own log
 * filter includes that whole day. Coding reads use an exclusive end, so the
 * bound moves to the start of the next local day.
 *
 * @param {string|Date|null|undefined} from
 * @param {string|Date|null|undefined} to
 * @returns {{from: string|undefined, to: string|undefined}}
 */
export function reportRangeBounds(from, to) {
  return {
    from: toIso(from),
    to: exclusiveLocalEnd(to),
  };
}

function toIso(value) {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

function exclusiveLocalEnd(value) {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const next = new Date(date.getTime());
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}
