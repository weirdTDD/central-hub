// Offline queue for learning heartbeats.
//
// The extension keeps this list in extension storage and sends it when the
// network is up. Sending the same heartbeat twice is safe because each one
// has a deterministic id; the queue still drops a duplicate locally so a long
// offline stretch does not grow without bound.

import { heartbeatKey } from "./learningTime.js";

export const QUEUE_LIMIT = 2000;

/**
 * @param {Array<object>} queue
 * @param {Array<object>} heartbeats
 * @param {number} [limit]
 * @returns {{queue: Array<object>, dropped: number}}
 */
export function enqueueHeartbeats(queue = [], heartbeats = [], limit = QUEUE_LIMIT) {
  const ordered = [];
  const index = new Map();

  const add = (heartbeat) => {
    const key = queueKey(heartbeat);
    if (!key) return;
    if (index.has(key)) {
      ordered[index.get(key)] = heartbeat;
      return;
    }
    index.set(key, ordered.length);
    ordered.push(heartbeat);
  };

  for (const heartbeat of queue) add(heartbeat);
  for (const heartbeat of heartbeats) add(heartbeat);

  const dropped = Math.max(0, ordered.length - limit);
  return {
    queue: dropped > 0 ? ordered.slice(ordered.length - limit) : ordered,
    dropped,
  };
}

/**
 * @param {Array<object>} queue
 * @param {Array<object>} sent
 * @returns {Array<object>}
 */
export function acknowledgeHeartbeats(queue = [], sent = []) {
  const done = new Set(sent.map(queueKey));
  return queue.filter((heartbeat) => !done.has(queueKey(heartbeat)));
}

/**
 * Delay before the next flush after a failure. Capped at five minutes.
 *
 * @param {number} failures
 * @returns {number} seconds
 */
export function nextBackoffSeconds(failures) {
  const count = Math.max(1, Math.round(Number(failures) || 1));
  return Math.min(300, 15 * 2 ** (count - 1));
}

function queueKey(heartbeat) {
  if (!heartbeat || typeof heartbeat !== "object") return "";
  return heartbeatKey(heartbeat);
}
