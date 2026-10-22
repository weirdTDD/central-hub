// Bar lengths for recorded time.
//
// A bar compares known durations. It is not a course grade and not a goal.
// Missing time stays missing: a null duration never becomes a zero-length
// "finished" bar, and it never becomes 0%.

/**
 * @param {number|null|undefined} part
 * @param {number|null|undefined} whole
 * @returns {number|null} 0–100, or null when either side is unknown
 */
export function sharePercent(part, whole) {
  if (part == null || whole == null) return null;
  const value = Number(part);
  const total = Number(whole);
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0 || value < 0) return null;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

/**
 * Each known positive value as a percent of the largest one.
 * Null stays null. A set with no positive value yields nulls.
 *
 * @param {Array<number|null|undefined>} values
 * @returns {Array<number|null>}
 */
export function peakScale(values = []) {
  let peak = null;
  for (const value of values) {
    const number = Number(value);
    if (value == null || !Number.isFinite(number) || number <= 0) continue;
    if (peak == null || number > peak) peak = number;
  }
  return values.map((value) => (value == null ? null : sharePercent(value, peak)));
}
