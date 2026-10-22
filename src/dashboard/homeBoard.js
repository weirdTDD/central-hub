// Shapes the dashboard home from recorded days.
//
// A filled week dot means time was recorded. The count is only the days in
// this loaded week, walking back from today. It is not an all-time streak
// and it is not experience points.

import { localDayKey } from "../lib/dates.js";

/**
 * @param {object} input
 * @param {Array<object>} [input.learning]
 * @param {Array<object>} [input.coding]
 * @param {Array<string>} [input.sessionDayKeys]
 * @param {string} input.timeZone
 * @returns {Set<string>}
 */
export function activeDayKeys({ learning = [], coding = [], sessionDayKeys = [], timeZone } = {}) {
  const keys = new Set(sessionDayKeys.filter(Boolean));
  for (const beat of [...learning, ...coding]) {
    if (!(Number(beat?.durationSeconds) > 0)) continue;
    const key = localDayKey(beat.occurredAt, timeZone);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Consecutive active days ending today, or ending yesterday when today is still empty.
 * Days after today are ignored. Days before this week are not loaded, so the count
 * cannot claim them.
 *
 * @param {Array<{key: string}>} days Monday–Sunday
 * @param {Set<string>} activeKeys
 * @param {string} today
 * @returns {number}
 */
export function streakInWeek(days = [], activeKeys, today) {
  const index = days.findIndex((day) => day.key === today);
  if (index < 0) return 0;
  let cursor = index;
  if (!activeKeys.has(days[cursor].key)) cursor -= 1;
  let count = 0;
  while (cursor >= 0 && activeKeys.has(days[cursor].key)) {
    count += 1;
    cursor -= 1;
  }
  return count;
}
