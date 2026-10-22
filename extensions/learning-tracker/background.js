// Central Hub learning tracker.
//
// Runs as a Manifest V3 service worker in Chrome and as an event page in
// Firefox. Active time is recorded only for the allowlist, and only while the
// window is focused and the user is active. The URL of a page is used to
// decide that and is not stored. Offline heartbeats stay in extension storage
// and are sent later. Each heartbeat has a deterministic id, so a retry does
// not create a second row.
//
// This file must not touch document or window. Chrome runs it without a DOM.

import { acknowledgeHeartbeats, enqueueHeartbeats, nextBackoffSeconds } from "./lib/queue.js";
import {
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_IDLE_SECONDS,
  initialLearningState,
  observationEvent,
  reduceLearning,
} from "./lib/learningTime.js";
import { detectBrowser, normalizeSiteList, parseSiteInput, resolveSites } from "./lib/sites.js";
import {
  buildGetIntegrationRequest,
  buildInsertHeartbeatsRequest,
  buildRefreshRequest,
  buildSignInRequest,
  buildUpsertIntegrationRequest,
  toObservationRow,
} from "./lib/transport.js";

const KEYS = {
  queue: "learning.queue",
  tracker: "learning.tracker",
  refresh: "learning.refreshToken",
  url: "learning.supabaseUrl",
  anon: "learning.anonKey",
  paused: "learning.paused",
  sites: "learning.sites",
  sitesKnown: "learning.sitesKnown",
  sitesDirty: "learning.sitesDirty",
  lastError: "learning.lastError",
};

const ALARM = "learning-tick";
const FLUSH_GAP_MS = 30_000;

let chain = Promise.resolve();
let lockDepth = 0;
let lastFlushAt = 0;
let sitesFetchedAt = 0;
let failures = 0;
let retryTimer = null;
let wakeTimer = null;

chrome.runtime.onInstalled.addListener(() => {
  setup();
});
chrome.runtime.onStartup.addListener(() => {
  setup();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === ALARM) sampleAndFlush(true).catch(rememberFailure);
});
chrome.idle.onStateChanged.addListener(() => wake());
chrome.tabs.onActivated.addListener(() => wake());
chrome.windows.onFocusChanged.addListener(() => wake());
chrome.tabs.onUpdated.addListener((_tabId, info) => {
  if (info.status === "complete" || info.url || info.title) wake();
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id !== chrome.runtime.id) return undefined;
  handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
  return true;
});

setup();

function setup() {
  try {
    chrome.idle.setDetectionInterval(DEFAULT_IDLE_SECONDS);
  } catch {
    // Idle events still report through queryState on the alarm.
  }
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  sampleAndFlush(false).catch(rememberFailure);
}

function wake() {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    sampleAndFlush(false).catch(rememberFailure);
  }, 800);
}

function exclusive(task) {
  // Re-entrant so a flush can sample and then write without waiting on itself.
  // Callers from outside still run one at a time, so an older tab sample cannot
  // be applied after a newer one.
  if (lockDepth > 0) return Promise.resolve().then(task);
  const run = chain.then(() => {
    lockDepth += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => {
        lockDepth -= 1;
      });
  });
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function sampleAndFlush(forceFlush) {
  await exclusive(async () => {
    await refreshSitesIfStale();
    const sample = await readSample();
    const event = observationEvent(sample);
    await applyEvent(event);
    await maybeFlush(forceFlush);
  });
}

async function readSample() {
  const stored = await storageGet([KEYS.paused, KEYS.sites, KEYS.sitesKnown, KEYS.sitesDirty]);
  const sites = resolveSites({
    cachedSites: stored[KEYS.sites],
    cacheKnown: stored[KEYS.sitesKnown] === true,
    cacheDirty: stored[KEYS.sitesDirty] === true,
  });
  const idleState = await queryIdle(DEFAULT_IDLE_SECONDS);
  const focused = await windowIsFocused();
  let url = null;
  let title = null;
  if (focused && idleState === "active") {
    const tab = await activeTab();
    url = typeof tab?.url === "string" ? tab.url : null;
    title = typeof tab?.title === "string" ? tab.title : null;
  }
  return {
    idleState,
    focused,
    url,
    title,
    sites,
    at: Date.now() / 1000,
    paused: stored[KEYS.paused] === true,
  };
}

async function applyEvent(event) {
  if (!event || event.type === "noop") return;
  await exclusive(async () => {
    const stored = await storageGet([KEYS.tracker, KEYS.queue, KEYS.paused]);
    const tracker = {
      ...initialLearningState(),
      ...(stored[KEYS.tracker] && typeof stored[KEYS.tracker] === "object" ? stored[KEYS.tracker] : {}),
      paused: stored[KEYS.paused] === true,
    };
    const result = reduceLearning(tracker, event, {
      heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
      idleSeconds: DEFAULT_IDLE_SECONDS,
    });
    const next = enqueueHeartbeats(stored[KEYS.queue] || [], result.heartbeats);
    const patch = {
      [KEYS.tracker]: result.state,
      [KEYS.queue]: next.queue,
    };
    if (next.dropped > 0) {
      patch[KEYS.lastError] = `${next.dropped} heartbeats were dropped because the offline queue is full.`;
    }
    await storageSet(patch);
  });
}

async function maybeFlush(force) {
  if (!force && Date.now() - lastFlushAt < FLUSH_GAP_MS) return;
  lastFlushAt = Date.now();
  await flush();
}

async function flush() {
  await exclusive(async () => {
    const stored = await storageGet([
      KEYS.url,
      KEYS.anon,
      KEYS.refresh,
      KEYS.queue,
      KEYS.paused,
      KEYS.sites,
      KEYS.sitesKnown,
      KEYS.sitesDirty,
    ]);
    const url = String(stored[KEYS.url] ?? "").trim();
    const anonKey = String(stored[KEYS.anon] ?? "").trim();
    const refreshToken = stored[KEYS.refresh];
    const queue = Array.isArray(stored[KEYS.queue]) ? stored[KEYS.queue] : [];
    if (!url || !anonKey || !refreshToken) {
      if (queue.length > 0) {
        await storageSet({
          [KEYS.lastError]: "Sign in from the extension options to send saved learning time.",
        });
      }
      return;
    }

    const accessToken = await refreshAccessToken(url, anonKey, refreshToken);
    const existingRows = await send(buildGetIntegrationRequest({ url, anonKey, accessToken }));
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    const sites = resolveSites({
      serverConfig: existing?.config,
      cachedSites: stored[KEYS.sites],
      cacheKnown: stored[KEYS.sitesKnown] === true,
      cacheDirty: stored[KEYS.sitesDirty] === true,
    });
    await storageSet({
      [KEYS.sites]: sites,
      [KEYS.sitesKnown]: true,
    });
    sitesFetchedAt = Date.now();
    const config = connectionConfig(sites, stored[KEYS.paused] === true);

    let guard = 0;
    let pending = queue;
    for (;;) {
      const current = await storageGet([KEYS.queue]);
      pending = Array.isArray(current[KEYS.queue]) ? current[KEYS.queue] : pending;
      const integration = await send(
        buildUpsertIntegrationRequest({
          url,
          anonKey,
          accessToken,
          status: pending.length > 0 ? "syncing" : "connected",
          lastError: pending.length > 0 ? undefined : null,
          config,
        })
      );
      const connection = Array.isArray(integration) ? integration[0] : integration;
      if (!connection?.id) throw new Error("Central Hub did not return the learning tracker connection.");
      if (pending.length === 0) break;

      guard += 1;
      if (guard > 40) break;

      const batch = pending.slice(0, 50);
      const { valid, invalid } = splitValid(batch, connection.id);
      if (invalid.length > 0) {
        pending = acknowledgeHeartbeats(pending, invalid);
        await storageSet({
          [KEYS.queue]: acknowledgeHeartbeats(
            (await storageGet([KEYS.queue]))[KEYS.queue] || [],
            invalid
          ),
          [KEYS.lastError]: `${invalid.length} queued records were dropped because they were not valid learning heartbeats.`,
        });
      }
      if (valid.length === 0) {
        if (pending.length === 0) break;
        continue;
      }
      await send(
        buildInsertHeartbeatsRequest({
          url,
          anonKey,
          accessToken,
          connectionId: connection.id,
          heartbeats: valid,
        })
      );
      const latest = (await storageGet([KEYS.queue]))[KEYS.queue] || [];
      const remaining = acknowledgeHeartbeats(latest, valid);
      await storageSet({ [KEYS.queue]: remaining, [KEYS.sitesDirty]: false, [KEYS.lastError]: "" });
      await send(
        buildUpsertIntegrationRequest({
          url,
          anonKey,
          accessToken,
          status: "connected",
          lastError: null,
          lastSyncAt: new Date().toISOString(),
          config,
        })
      );
      pending = remaining;
      if (remaining.length === 0) break;
    }
    if (pending.length === 0) {
      const patch = { [KEYS.sitesDirty]: false };
      if (queue.length === 0) patch[KEYS.lastError] = "";
      await storageSet(patch);
    }
    failures = 0;
  });
}

async function refreshSitesIfStale() {
  if (Date.now() - sitesFetchedAt < 60_000) return;
  await exclusive(async () => {
    if (Date.now() - sitesFetchedAt < 60_000) return;
    sitesFetchedAt = Date.now();
    const stored = await storageGet([KEYS.url, KEYS.anon, KEYS.refresh, KEYS.sitesDirty]);
    if (stored[KEYS.sitesDirty] === true) return;
    const url = String(stored[KEYS.url] ?? "").trim();
    const anonKey = String(stored[KEYS.anon] ?? "").trim();
    if (!url || !anonKey || !stored[KEYS.refresh]) return;
    try {
      const accessToken = await refreshAccessToken(url, anonKey, stored[KEYS.refresh]);
      const rows = await send(buildGetIntegrationRequest({ url, anonKey, accessToken }));
      const existing = Array.isArray(rows) ? rows[0] : null;
      if (existing?.config && Array.isArray(existing.config.sites)) {
        await storageSet({
          [KEYS.sites]: normalizeSiteList(existing.config.sites),
          [KEYS.sitesKnown]: true,
        });
      }
    } catch {
      sitesFetchedAt = Date.now() - 50_000;
    }
  });
}

function connectionConfig(sites, paused) {
  return {
    sites,
    paused,
    browser: detectBrowser(globalThis.navigator?.userAgent),
    heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
    idleSeconds: DEFAULT_IDLE_SECONDS,
  };
}

function splitValid(heartbeats, connectionId) {
  const valid = [];
  const invalid = [];
  for (const beat of heartbeats) {
    try {
      toObservationRow(beat, connectionId);
      valid.push(beat);
    } catch {
      invalid.push(beat);
    }
  }
  return { valid, invalid };
}

async function handleMessage(message) {
  const type = message?.type;
  if (type === "getStatus") return getStatus();
  if (type === "signIn") return signIn(message);
  if (type === "signOut") return signOut();
  if (type === "setPaused") return setPaused(message?.paused === true);
  if (type === "saveSites") return saveSites(message?.sites);
  if (type === "addSite") return addSite(message?.pattern, message?.label);
  throw new Error("Unknown request.");
}

async function getStatus() {
  const stored = await storageGet([
    KEYS.paused,
    KEYS.refresh,
    KEYS.queue,
    KEYS.lastError,
    KEYS.tracker,
    KEYS.sites,
    KEYS.sitesKnown,
    KEYS.sitesDirty,
    KEYS.url,
    KEYS.anon,
  ]);
  const tracker = stored[KEYS.tracker];
  const queue = Array.isArray(stored[KEYS.queue]) ? stored[KEYS.queue] : [];
  return {
    ok: true,
    paused: stored[KEYS.paused] === true,
    signedIn: Boolean(stored[KEYS.refresh]),
    queued: queue.length,
    lastError: stored[KEYS.lastError] || "",
    tracked: trackedNow(tracker, stored[KEYS.paused] === true),
    sites: resolveSites({
      cachedSites: stored[KEYS.sites],
      cacheKnown: stored[KEYS.sitesKnown] === true,
      cacheDirty: stored[KEYS.sitesDirty] === true,
    }),
    sitesExplicit: stored[KEYS.sitesKnown] === true,
    url: String(stored[KEYS.url] ?? ""),
    anonKeySet: Boolean(stored[KEYS.anon]),
  };
}

function trackedNow(tracker, paused) {
  if (!tracker || paused || tracker.focused !== true || !tracker.siteHost) return null;
  if (!Number.isFinite(tracker.lastActivityAt)) return null;
  if (Date.now() / 1000 - tracker.lastActivityAt > DEFAULT_IDLE_SECONDS) return null;
  return {
    siteLabel: tracker.siteLabel || tracker.siteHost,
    courseLabel: tracker.courseLabel || null,
    lessonLabel: tracker.lessonLabel || null,
  };
}

async function signIn(message) {
  const url = String(message?.url ?? "").trim();
  const anonKey = String(message?.anonKey ?? "").trim();
  const email = String(message?.email ?? "").trim();
  const password = String(message?.password ?? "");
  if (!url || !anonKey || !email || !password) {
    throw new Error("Enter the Supabase URL, the anon key, your email, and your password.");
  }
  const request = buildSignInRequest({ url, anonKey, email, password });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.refresh_token) {
    throw new Error(body.error_description || body.msg || body.error || "Sign-in failed.");
  }
  await storageSet({
    [KEYS.refresh]: body.refresh_token,
    [KEYS.url]: url,
    [KEYS.anon]: anonKey,
    [KEYS.lastError]: "",
  });
  failures = 0;
  sitesFetchedAt = 0;
  await flush().catch(rememberFailure);
  return getStatus();
}

async function signOut() {
  await storageRemove([KEYS.refresh]);
  await storageSet({ [KEYS.lastError]: "" });
  return getStatus();
}

async function setPaused(paused) {
  await storageSet({ [KEYS.paused]: paused });
  await applyEvent(paused ? { type: "pause", at: Date.now() / 1000 } : { type: "resume", at: Date.now() / 1000 });
  await maybeFlush(true).catch(rememberFailure);
  return getStatus();
}

async function addSite(pattern, label) {
  const site = parseSiteInput(pattern, label);
  const status = await getStatus();
  if (status.sites.some((item) => item.id === site.id)) {
    throw new Error("That site is already tracked.");
  }
  return saveSites([...status.sites, site]);
}

async function saveSites(input) {
  const sites = normalizeSiteList(input);
  await storageSet({
    [KEYS.sites]: sites,
    [KEYS.sitesKnown]: true,
    [KEYS.sitesDirty]: true,
  });
  sitesFetchedAt = 0;
  const stored = await storageGet([KEYS.refresh, KEYS.url, KEYS.anon]);
  if (stored[KEYS.refresh] && stored[KEYS.url] && stored[KEYS.anon]) {
    await flush();
  }
  return getStatus();
}

async function refreshAccessToken(url, anonKey, refreshToken) {
  const request = buildRefreshRequest({ url, anonKey, refreshToken });
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(body.error_description || body.msg || body.error || "The Central Hub session expired. Sign in again.");
  }
  if (body.refresh_token) await storageSet({ [KEYS.refresh]: body.refresh_token });
  return body.access_token;
}

async function send(request) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 180) };
    }
  }
  if (!response.ok) {
    const message =
      (body && (body.message || body.error_description || body.msg || body.error)) ||
      `Central Hub returned ${response.status}.`;
    throw new Error(typeof message === "string" ? message : "Central Hub rejected the learning heartbeat.");
  }
  return body;
}

function rememberFailure(error) {
  failures += 1;
  const message = publicError(error);
  storageSet({ [KEYS.lastError]: message }).catch(() => {});
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    maybeFlush(true).catch(() => {});
  }, nextBackoffSeconds(failures) * 1000);
}

function publicError(error) {
  const text = error instanceof Error ? error.message : String(error ?? "Something went wrong.");
  return text.replace(/bearer\s+\S+/gi, "bearer [redacted]").slice(0, 300);
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items || {});
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function windowIsFocused() {
  return new Promise((resolve) => {
    chrome.windows.getLastFocused({}, (win) => {
      if (chrome.runtime.lastError || !win) resolve(false);
      else resolve(win.focused === true);
    });
  });
}

async function activeTab() {
  const win = await new Promise((resolve) => {
    chrome.windows.getLastFocused({}, (found) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(found || null);
    });
  });
  if (!win?.id && win?.id !== 0) return null;
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(tabs?.[0] ?? null);
    });
  });
}

function queryIdle(seconds) {
  return new Promise((resolve) => {
    try {
      chrome.idle.queryState(Math.max(15, seconds), (state) => {
        if (chrome.runtime.lastError) resolve("idle");
        else resolve(state || "idle");
      });
    } catch {
      resolve("idle");
    }
  });
}
