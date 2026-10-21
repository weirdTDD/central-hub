/**
 * Date helpers shared by the whole app.
 *
 * The app files work logs and sessions under the user's LOCAL calendar day. The day
 * key must therefore be computed in one place: a UTC day key and a local day key
 * disagree for a large part of the day, and a log filed under the wrong day silently
 * moves the totals.
 */

const formatterCache = new Map();

/**
 * A cached `Intl.DateTimeFormat` for a timezone.
 *
 * Formatter construction is the expensive part of `Intl`, and the same timezone is
 * used for every entry of a list.
 */
function formatterFor(timeZone) {
  const key = timeZone ?? "default";
  if (!formatterCache.has(key)) {
    formatterCache.set(
      key,
      new Intl.DateTimeFormat("en-CA", {
        ...(timeZone ? { timeZone } : {}),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    );
  }
  return formatterCache.get(key);
}

/**
 * The local calendar day of an instant.
 *
 * @param {string|number|Date} [value] the instant (defaults to now)
 * @param {string} [timeZone] an IANA timezone; the runtime's local zone when omitted
 * @returns {string|null} 'YYYY-MM-DD', or null when the instant is invalid
 */
export function localDayKey(value = new Date(), timeZone = undefined) {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value * 1000)
        : new Date(value);

  if (!Number.isFinite(date.getTime())) return null;

  try {
    return formatterFor(timeZone).format(date);
  } catch {
    // An unknown timezone must not lose the record: fall back to UTC rather than throw.
    return date.toISOString().slice(0, 10);
  }
}

/**
 * The user's timezone as reported by the runtime.
 *
 * @returns {string} an IANA timezone name, e.g. "Europe/Berlin"
 */
export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
