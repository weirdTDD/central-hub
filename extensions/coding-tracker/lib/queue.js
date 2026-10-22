// Offline queue for coding heartbeats.
//
// The extension keeps this list on disk (VS Code globalState) and sends it when
// the network is up. Sending the same heartbeat twice is safe because each one
// has a deterministic id; the queue still drops a duplicate locally so a long
// offline stretch does not grow without bound.

export const QUEUE_LIMIT = 2000;

/**
 * Adds heartbeats to the queue.
 *
 * A heartbeat already present (same editor, project, file, language, start and
 * duration) is replaced in place. When the queue is over the limit, the oldest
 * entries are dropped and the count is reported — the loss is not hidden.
 *
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
 * Removes heartbeats that were accepted by the store.
 *
 * Anything not in `sent` stays queued, including a heartbeat the store has
 * never seen.
 *
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
 * @param {number} failures how many failures have happened in a row (1-based)
 * @returns {number} seconds
 */
export function nextBackoffSeconds(failures) {
  const count = Math.max(1, Math.round(Number(failures) || 1));
  return Math.min(300, 15 * 2 ** (count - 1));
}

function queueKey(heartbeat) {
  if (!heartbeat || typeof heartbeat !== "object") return "";
  const occurredAt = heartbeat.occurredAt ?? heartbeat.occurred_at ?? "";
  const duration = heartbeat.durationSeconds ?? heartbeat.duration_seconds ?? "";
  return [
    heartbeat.editor ?? "",
    heartbeat.projectName ?? heartbeat.project_name ?? "",
    heartbeat.fileName ?? heartbeat.file_name ?? "",
    heartbeat.language ?? "",
    occurredAt,
    duration,
  ].join("|");
}
