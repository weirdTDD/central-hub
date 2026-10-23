// Sentral Hub — learning tracker assertions.
//
// Run:  node scripts/verify-learning.mjs
//
// Exit code 0 = every assertion passed, 1 = at least one failed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { deterministicUuid as appUuid } from "../src/lib/stableId.js";
import { deterministicUuid as extensionUuid } from "../extensions/learning-tracker/lib/stableId.js";
import {
  ACTIVITY_KIND,
  coveredSeconds,
  foldHeartbeats,
  groupedCoveredSeconds,
  heartbeatsFromRows,
  initialLearningState,
  observationEvent,
  reduceLearning,
  scopeHeartbeatId,
} from "../extensions/learning-tracker/lib/learningTime.js";
import { acknowledgeHeartbeats, enqueueHeartbeats, nextBackoffSeconds } from "../extensions/learning-tracker/lib/queue.js";
import {
  DEFAULT_SITES,
  SUGGESTED_SITES,
  describeTrackedPage,
  detectBrowser,
  hostMatches,
  parseSiteInput,
  resolveSites,
} from "../extensions/learning-tracker/lib/sites.js";
import {
  buildInsertHeartbeatsRequest,
  buildSignInRequest,
  buildUpsertIntegrationRequest,
  toObservationRow,
} from "../extensions/learning-tracker/lib/transport.js";
import { learningTrackerAdapter } from "../src/features/integrations/adapters/learningTracker.js";
import { peakScale, sharePercent } from "../src/features/progress/scale.js";
import { getAdapter } from "../src/features/integrations/contract.js";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (error) {
    if (pattern && !pattern.test(error.message)) {
      throw new Error(`threw ${JSON.stringify(error.message)}, expected ${pattern}`);
    }
    return;
  }
  throw new Error("expected a throw");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FCC =
  "https://www.freecodecamp.org/learn/javascript-algorithms-and-data-structures-v8/learn-basic-javascript-by-building-a-role-playing-game/step-3?token=secret";

function page(at, extra = {}) {
  return {
    type: "activity",
    at,
    siteHost: "freecodecamp.org",
    siteLabel: "freeCodeCamp",
    courseLabel: "JavaScript Algorithms and Data Structures v8",
    lessonLabel: "Learn Basic JavaScript by Building a Role Playing Game · Step 3",
    pageTitle: "Step 3",
    ...extra,
  };
}

function run(events, options) {
  let state = initialLearningState();
  const heartbeats = [];
  for (const event of events) {
    const result = reduceLearning(state, event, options);
    state = result.state;
    heartbeats.push(...result.heartbeats);
  }
  return { state, heartbeats };
}

function sampleRun(samples) {
  let state = initialLearningState();
  const heartbeats = [];
  for (const sample of samples) {
    const event = observationEvent({ sites: DEFAULT_SITES, ...sample });
    const result = reduceLearning(state, event);
    state = result.state;
    heartbeats.push(...result.heartbeats);
  }
  return { state, heartbeats, lastEvent: observationEvent({ sites: DEFAULT_SITES, ...samples.at(-1) }) };
}

console.log("Sentral Hub — learning tracker assertions\n");

console.log("Allowlist");
check("the default list is freeCodeCamp curriculum and nothing else", () => {
  assertEqual(DEFAULT_SITES.length, 1, "one default");
  assertEqual(DEFAULT_SITES[0].host, "freecodecamp.org", "host");
  assertEqual(DEFAULT_SITES[0].pathPrefix, "/learn", "curriculum path");
  assertEqual(DEFAULT_SITES[0].includeSubdomains, false, "no extra subdomains");
  assert(SUGGESTED_SITES.length > 1, "suggestions exist");
  assert(
    !SUGGESTED_SITES.some((site) => site.host === "freecodecamp.org" && site.pathPrefix === "" && site.includeSubdomains),
    "suggestions do not open every freecodecamp subdomain"
  );
});

check("matching stays on the allowlist and ignores the query string", () => {
  const described = describeTrackedPage(FCC, DEFAULT_SITES, "Step 3 | freeCodeCamp.org");
  assertEqual(described.siteHost, "freecodecamp.org", "host");
  assertEqual(described.siteLabel, "freeCodeCamp", "label");
  assertEqual(described.courseLabel, "JavaScript Algorithms and Data Structures v8", "course");
  assert(
    described.lessonLabel.includes("Role Playing Game") && described.lessonLabel.includes("Step 3"),
    "lesson keeps the workshop and the step"
  );
  assert(!JSON.stringify(described).includes("token"), "query token is not stored");
  assert(!JSON.stringify(described).includes("http"), "url is not stored");
  assertEqual(describeTrackedPage("https://forum.freecodecamp.org/t/hello", DEFAULT_SITES, "Forum"), null, "forum subdomain");
  assertEqual(describeTrackedPage("https://www.freecodecamp.org/news/hello", DEFAULT_SITES, "News"), null, "news path");
  assertEqual(describeTrackedPage("https://mail.google.com/mail/u/0/", DEFAULT_SITES, "Inbox"), null, "other site");
  assertEqual(describeTrackedPage("chrome://extensions", DEFAULT_SITES, "Extensions"), null, "non-http");
  const wide = [{ host: "freecodecamp.org", includeSubdomains: true, label: "freeCodeCamp", pathPrefix: "" }];
  assert(hostMatches("chinese.freecodecamp.org", { host: "freecodecamp.org", includeSubdomains: true }), "wildcard");
  assert(describeTrackedPage("https://chinese.freecodecamp.org/learn/a", wide, "A"), "wildcard page");
  assert(!hostMatches("notfreecodecamp.org", { host: "freecodecamp.org", includeSubdomains: true }), "suffix trick");
});

check("a site pattern keeps the host and path and rejects secrets", () => {
  const site = parseSiteInput("https://www.freecodecamp.org/learn/", "Camp");
  assertEqual(site.host, "freecodecamp.org", "www folded");
  assertEqual(site.pathPrefix, "/learn", "path");
  assertEqual(site.label, "Camp", "label");
  const wildcard = parseSiteInput("*.example.com/docs", "");
  assertEqual(wildcard.includeSubdomains, true, "subdomains");
  assertEqual(wildcard.pathPrefix, "/docs", "wildcard path");
  assertThrows(() => parseSiteInput("https://videos.example.com/watch?token=abc"), /Query strings/);
  assertThrows(() => parseSiteInput("https://user:pass@example.com/learn"), /username or password/);
  assertThrows(() => parseSiteInput("file:///tmp/secret"), /http and https/);
});

check("an explicit empty list stays empty, and a missing list uses the default", () => {
  assertEqual(resolveSites({ serverConfig: { sites: [] } }).length, 0, "owner cleared the list");
  assertEqual(resolveSites({}).length, 1, "default");
  assertEqual(
    resolveSites({
      serverConfig: { sites: [{ host: "javascript.info", label: "javascript.info", pathPrefix: "" }] },
      cachedSites: DEFAULT_SITES,
      cacheKnown: true,
    })[0].host,
    "javascript.info",
    "server wins"
  );
  assertEqual(
    resolveSites({
      serverConfig: { sites: [] },
      cachedSites: [{ host: "javascript.info", label: "javascript.info", pathPrefix: "" }],
      cacheKnown: true,
      cacheDirty: true,
    })[0].host,
    "javascript.info",
    "an unsaved local edit wins until it is written"
  );
});

check("a page title that is a URL or carries a token is dropped", () => {
  const described = describeTrackedPage(
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
    [{ host: "developer.mozilla.org", label: "MDN Web Docs", pathPrefix: "", includeSubdomains: false }],
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript?token=secret"
  );
  assertEqual(described.siteHost, "developer.mozilla.org", "host");
  assertEqual(described.pageTitle, null, "url title dropped");
  assertEqual(described.courseLabel, null, "no invented course");
});

console.log("\nActive time");
check("a single sample has no measured span", () => {
  const { heartbeats } = run([page(0), { type: "tick", at: 400 }]);
  assertEqual(heartbeats.length, 0, "nothing stored");
});

check("time is the span between active samples, and idle is not counted", () => {
  const { heartbeats } = run([page(0), page(50), { type: "idle", at: 50 + 7200 }]);
  assertEqual(heartbeats.length, 1, "one heartbeat");
  assertEqual(heartbeats[0].durationSeconds, 50, "fifty active seconds");
  assertEqual(heartbeats[0].siteHost, "freecodecamp.org", "host");
  assertEqual(heartbeats[0].activityKind, "learning", "kind");
  assert(!JSON.stringify(heartbeats[0]).includes("http"), "no url");
  assert(heartbeats[0].durationSeconds < 7200, "the idle gap is not active time");
});

check("switching lessons attributes the gap to the lesson that was active", () => {
  const { heartbeats } = run([
    page(0, { lessonLabel: "Step 1" }),
    page(40, { lessonLabel: "Step 2" }),
    { type: "tick", at: 400 },
  ]);
  assertEqual(heartbeats.length, 1, "the new lesson has no span yet");
  assertEqual(heartbeats[0].lessonLabel, "Step 1", "old lesson");
  assertEqual(heartbeats[0].durationSeconds, 40, "gap");
});

check("pause, blur, and an unfocused or unlisted page do not keep the clock running", () => {
  const paused = run([page(0), page(20), { type: "pause", at: 25 }, page(80), page(100)]);
  assertEqual(paused.heartbeats.length, 1, "pause flushes the span");
  assertEqual(paused.heartbeats[0].durationSeconds, 20, "only the active span");

  const away = sampleRun([
    { idleState: "active", focused: true, url: FCC, title: "Step 3", at: 0 },
    { idleState: "active", focused: true, url: FCC, title: "Step 3", at: 30 },
    { idleState: "active", focused: false, url: "https://mail.google.com/mail", title: "Inbox", at: 40 },
    { idleState: "active", focused: false, url: "https://mail.google.com/mail", title: "Inbox", at: 100 },
  ]);
  assertEqual(away.heartbeats.reduce((sum, beat) => sum + beat.durationSeconds, 0), 40, "focused span plus the short bridge");
  assert(!JSON.stringify(away.lastEvent).includes("mail.google"), "the other site is not in the event");
  assert(!JSON.stringify(away.heartbeats).includes("mail.google"), "the other site is not stored");

  const other = sampleRun([
    { idleState: "active", focused: true, url: FCC, title: "Step 3", at: 0 },
    { idleState: "active", focused: true, url: FCC, title: "Step 3", at: 20 },
    { idleState: "active", focused: true, url: "https://mail.google.com/mail", title: "Inbox", at: 35 },
  ]);
  assertEqual(other.heartbeats[0].durationSeconds, 35, "time until leaving the allowlist");
  assertEqual(other.heartbeats[0].siteHost, "freecodecamp.org", "still the learning site");
});

check("an older sample does not rewind a newer one", () => {
  const { heartbeats, state } = run([page(0), page(40), page(10)]);
  assertEqual(heartbeats.length, 0, "the late sample adds no heartbeat");
  assertEqual(state.lastActivityAt, 40, "the clock stays on the newer sample");
  assertEqual(state.lessonLabel, "Learn Basic JavaScript by Building a Role Playing Game · Step 3", "context stays");
});

check("a long gap while leaving is not invented, and idle does not bridge", () => {
  const left = run([page(0), { type: "leave", at: 90, bridge: true }]);
  assertEqual(left.heartbeats.length, 0, "a gap longer than one heartbeat is missing");
  const idled = run([page(0), page(20), { type: "idle", at: 80 }]);
  assertEqual(idled.heartbeats[0].durationSeconds, 20, "idle does not add the wait");
});

check("samples outside the allowlist produce a leave event with no address", () => {
  const event = observationEvent({
    idleState: "active",
    focused: true,
    url: "https://mail.google.com/mail?authuser=me",
    title: "Inbox",
    sites: DEFAULT_SITES,
    at: 10,
  });
  assertEqual(event.type, "leave", "leave");
  assert(!JSON.stringify(event).includes("google"), "address dropped");
  assert(!JSON.stringify(event).includes("authuser"), "query dropped");
});

console.log("\nSessions and totals");
check("sessions group by site and course and keep lessons inside", () => {
  const beats = [
    beat("2026-10-22T10:00:00.000Z", 60, { lessonLabel: "Step 1" }),
    beat("2026-10-22T10:01:00.000Z", 60, { lessonLabel: "Step 2" }),
    beat("2026-10-22T11:00:00.000Z", 30, { lessonLabel: "Step 3" }),
    beat("2026-10-22T11:00:00.000Z", 30, { siteHost: "javascript.info", siteLabel: "javascript.info", courseLabel: null, lessonLabel: "Objects" }),
  ];
  const sessions = foldHeartbeats(beats);
  assertEqual(sessions.length, 3, "gap, then site");
  assertEqual(sessions[0].durationSeconds, 120, "first two heartbeats");
  assertEqual(sessions[0].lessons.length, 2, "both lessons");
  assertEqual(sessions[2].siteHost, "javascript.info", "other site");
});

check("overlapping sites are counted once in the total", () => {
  const beats = [
    beat("2026-10-22T10:00:00.000Z", 120, {}),
    beat("2026-10-22T10:00:00.000Z", 120, { siteHost: "javascript.info", siteLabel: "javascript.info", courseLabel: null }),
  ];
  assertEqual(coveredSeconds(beats), 120, "union");
  const sites = groupedCoveredSeconds(beats, (item) => item.siteHost);
  const siteSum = sites.reduce((sum, row) => sum + row.activeSeconds, 0);
  assert(siteSum > coveredSeconds(beats), "per-site sums can exceed the union");
});

check("a heartbeat with no duration is missing, not zero", () => {
  const rows = heartbeatsFromRows([
    { occurred_at: "2026-10-22T10:00:00.000Z", duration_seconds: null, site_host: "freecodecamp.org", activity_kind: "learning" },
  ]);
  assertEqual(coveredSeconds(rows), null, "no measured coverage");
  const [session] = foldHeartbeats(rows);
  assertEqual(session.durationSeconds, null, "session duration");
});

check("the same heartbeat id is stable per connection and different across connections", () => {
  const heartbeat = beat("2026-10-22T10:00:00.000Z", 60, {});
  const first = scopeHeartbeatId("connection-a", heartbeat);
  const second = scopeHeartbeatId("connection-a", heartbeat);
  const other = scopeHeartbeatId("connection-b", heartbeat);
  assertEqual(first, second, "stable");
  assert(first !== other, "scoped");
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(first), "uuid shape");
});

check("the extension's id function matches the app's", () => {
  assertEqual(appUuid("learning|freecodecamp.org"), extensionUuid("learning|freecodecamp.org"), "same id");
});

check("browser names are only the ones the extension can tell apart", () => {
  assertEqual(detectBrowser("Mozilla/5.0 Firefox/128.0"), "firefox", "firefox");
  assertEqual(detectBrowser("Mozilla/5.0 Chrome/120.0"), "chrome", "chrome");
  assertEqual(detectBrowser("Mozilla/5.0 Edg/120.0"), "edge", "edge");
});

console.log("\nQueue and transport");
check("the queue dedupes, drops the oldest when full, and acknowledges a sent batch", () => {
  const first = beat("2026-10-22T10:00:00.000Z", 10, { lessonLabel: "A" });
  const second = beat("2026-10-22T10:01:00.000Z", 10, { lessonLabel: "B" });
  const third = beat("2026-10-22T10:02:00.000Z", 10, { lessonLabel: "C" });
  const deduped = enqueueHeartbeats([first], [first, second]);
  assertEqual(deduped.queue.length, 2, "duplicate collapsed");
  assertEqual(deduped.dropped, 0, "nothing dropped");
  const limited = enqueueHeartbeats([first, second], [third], 2);
  assertEqual(limited.dropped, 1, "one dropped");
  assertEqual(limited.queue[0].lessonLabel, "B", "oldest dropped");
  const left = acknowledgeHeartbeats([first, second, third], [second]);
  assertEqual(left.map((item) => item.lessonLabel).join(","), "A,C", "only the sent one leaves");
});

check("retry backoff grows and then caps", () => {
  assertEqual(nextBackoffSeconds(1), 15, "first");
  assertEqual(nextBackoffSeconds(2), 30, "second");
  assertEqual(nextBackoffSeconds(8), 300, "cap");
});

check("a heartbeat write is idempotent and carries no URL and no password", () => {
  const heartbeat = beat("2026-10-22T10:00:00.000Z", 60, {});
  const request = buildInsertHeartbeatsRequest({
    url: "https://example.supabase.co/",
    anonKey: "anon",
    accessToken: "token",
    connectionId: "connection-a",
    heartbeats: [heartbeat],
  });
  assert(request.url.includes("/rest/v1/observations?on_conflict=id"), "upsert url");
  assertEqual(request.headers.Prefer, "resolution=ignore-duplicates,return=representation", "duplicates ignored");
  const body = JSON.parse(request.body);
  assertEqual(body[0].activity_kind, ACTIVITY_KIND, "kind");
  assertEqual(body[0].source, "collector", "source");
  assertEqual(body[0].site_host, "freecodecamp.org", "host");
  assertEqual(body[0].window_title, null, "no window title");
  assertEqual(body[0].integration_id, "connection-a", "provenance");
  assert(!("editor" in body[0]), "not a coding row");
  assert(!("url" in body[0]), "no url column");
  assert(!request.body.includes("http://"), "no stored url");
  assert(!request.body.toLowerCase().includes("password"), "no password");
  assertThrows(() => toObservationRow({ ...heartbeat, url: FCC }, "connection-a"), /must not include a URL/);
  assertThrows(() => toObservationRow({ ...heartbeat, siteHost: "https://freecodecamp.org/learn" }, "connection-a"), /host name/);
});

check("a successful sync time is omitted until heartbeats are stored", () => {
  const request = buildUpsertIntegrationRequest({
    url: "https://example.supabase.co",
    anonKey: "anon",
    accessToken: "token",
    status: "syncing",
    config: { sites: DEFAULT_SITES, paused: false, browser: "chrome" },
  });
  const body = JSON.parse(request.body);
  assertEqual(body.provider, "learning_tracker", "provider");
  assertEqual(body.status, "syncing", "status");
  assertEqual(body.config.sites[0].host, "freecodecamp.org", "allowlist");
  assert(!("last_sync_at" in body), "success time is not cleared or invented");
  assert(!("last_error" in body), "an old error is left alone");
  const signIn = buildSignInRequest({
    url: "https://example.supabase.co",
    anonKey: "anon",
    email: "me@example.com",
    password: "secret",
  });
  assert(signIn.url.includes("grant_type=password"), "password grant");
  assert(!signIn.url.includes("secret"), "password stays out of the url");
});

console.log("\nApp contract");
check("the learning adapter is registered and refuses a URL", () => {
  assertEqual(getAdapter("learning_tracker")?.id, "learning_tracker", "registered");
  assertEqual(getAdapter("learning_tracker")?.timelinePath, "/learning", "timeline");
  const parsed = learningTrackerAdapter.parse(
    JSON.stringify({
      version: 1,
      heartbeats: [
        {
          occurredAt: "2026-10-22T10:00:00.000Z",
          durationSeconds: 60,
          siteHost: "freecodecamp.org",
          siteLabel: "freeCodeCamp",
          courseLabel: "JavaScript",
          lessonLabel: "Step 1",
          pageTitle: "Step 1",
        },
      ],
    })
  );
  const [observation] = learningTrackerAdapter.toObservations(parsed.records);
  assertEqual(observation.activityKind, "learning", "kind");
  assertEqual(observation.siteHost, "freecodecamp.org", "host");
  assertEqual(observation.windowTitle, null, "no window title");
  assertEqual(observation.source, "collector", "source");
  assertThrows(
    () =>
      learningTrackerAdapter.parse(
        JSON.stringify({
          heartbeats: [
            {
              occurredAt: "2026-10-22T10:00:00.000Z",
              durationSeconds: 10,
              siteHost: "freecodecamp.org",
              url: "https://www.freecodecamp.org/learn/secret",
            },
          ],
        })
      ),
    /must not include a URL/
  );
});

check("a progress bar compares known time and leaves missing time missing", () => {
  assertEqual(sharePercent(30, 60), 50, "half");
  assertEqual(sharePercent(null, 60), null, "missing part");
  assertEqual(sharePercent(30, null), null, "missing whole");
  assertEqual(sharePercent(30, 0), null, "no whole");
  assertEqual(peakScale([null, 10, 40]).join(","), ",25,100", "peak");
  assertEqual(peakScale([null, null]).join(","), ",", "no peak");
});

check("the migration allows coding and learning and does not store a URL", () => {
  const sql = readFileSync(path.join(root, "supabase/migrations/20261022150000_learning_activity.sql"), "utf8");
  assert(sql.includes("activity_kind in ('coding', 'learning')"), "kind check");
  assert(sql.includes("site_host"), "host column");
  assert(sql.includes("page_title"), "title column");
  assert(sql.includes("course_label"), "course column");
  assert(sql.includes("lesson_label"), "lesson column");
  assert(sql.includes("public.observations does not exist"), "preflight");
  assert(sql.includes("activity_kind = 'learning'"), "partial index");
  const coding = readFileSync(path.join(root, "supabase/migrations/20261022140000_coding_activity.sql"), "utf8");
  assert(coding.includes("position('learning' in definition)"), "coding migration will not drop learning");
  const background = readFileSync(path.join(root, "extensions/learning-tracker/background.js"), "utf8");
  assert(!background.includes("password:"), "password is not a stored field name");
  assert(background.includes("learning.refreshToken"), "refresh token is what is kept");
  assert(background.includes('"signIn"'), "sign-in is a message");
});

function beat(occurredAt, durationSeconds, extra) {
  return {
    occurredAt,
    durationSeconds,
    siteHost: "freecodecamp.org",
    siteLabel: "freeCodeCamp",
    courseLabel: "JavaScript Algorithms and Data Structures v8",
    lessonLabel: "Step 1",
    pageTitle: "Step 1",
    ...extra,
  };
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  process.exitCode = 1;
}
