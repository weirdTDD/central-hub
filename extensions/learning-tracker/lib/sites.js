// Allowlist for the learning tracker.
//
// A site is tracked only when its host (and, when set, its path prefix) is on
// this list. The address itself is never stored: matching reads a URL in
// memory and returns the host, the site label, and — when the page shape is
// known — a course and a lesson. Query strings, hashes, and non-matching
// pages are dropped here, before anything is queued.

/** Heartbeat length. One stored row covers up to this many active seconds. */
export const DEFAULT_HEARTBEAT_SECONDS = 60;

/** No input for this long ends the active slice. */
export const DEFAULT_IDLE_SECONDS = 120;

/** Sessions split when the gap between heartbeats is longer than this. */
export const DEFAULT_GAP_SECONDS = 120;

export const LEARNING_PROVIDER = "learning_tracker";

export const ACTIVITY_KIND = "learning";

/** Matches public.observations.site_host. Keep the SQL constraint in step. */
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const LABEL_MAX = 80;
const TITLE_MAX = 180;
const TRACK_MAX = 160;
const PATH_MAX = 200;
const SITE_LIMIT = 40;

const SPECIAL_WORDS = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  css: "CSS",
  html: "HTML",
  api: "API",
  sql: "SQL",
  json: "JSON",
  nodejs: "Node.js",
  react: "React",
  python: "Python",
  github: "GitHub",
  npm: "npm",
  v8: "v8",
};

const SMALL_WORDS = new Set(["a", "an", "and", "by", "of", "the", "to"]);

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isHostname(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 253 && HOSTNAME.test(value);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function cleanText(value, max) {
  if (value == null) return null;
  let text = "";
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    text += code <= 31 || code === 127 ? " " : char;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text || text.includes("://")) return null;
  if (/([?&])(token|access_token|password|secret|code|key)=/i.test(text)) return null;
  return text.length > max ? text.slice(0, max).trim() : text;
}

/** @param {unknown} value @returns {string|null} */
export function sanitizeLabel(value) {
  return cleanText(value, LABEL_MAX);
}

/** A page title. A URL or a title that carries a token is dropped. */
export function sanitizeTitle(value) {
  return cleanText(value, TITLE_MAX);
}

/** Course or lesson text. */
export function sanitizeTrackLabel(value) {
  return cleanText(value, TRACK_MAX);
}

/**
 * @param {string} slug
 * @returns {string|null}
 */
export function humanizeSlug(slug) {
  const words = String(slug ?? "")
    .split(/[-_]+/)
    .filter(Boolean)
    .slice(0, 24);
  if (words.length === 0) return null;
  const text = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (SPECIAL_WORDS[lower]) return SPECIAL_WORDS[lower];
      if (/^\d+$/.test(word)) return word;
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
  return sanitizeTrackLabel(text);
}

/**
 * @param {string} host
 * @param {string} pathPrefix
 * @param {boolean} includeSubdomains
 * @returns {string}
 */
export function siteId(host, pathPrefix, includeSubdomains) {
  return `${includeSubdomains ? "*." : ""}${host}${pathPrefix}`;
}

/**
 * @param {object|null|undefined} site
 * @returns {object|null}
 */
export function normalizeSite(site) {
  if (!site || typeof site !== "object") return null;
  const host = String(site.host ?? "").trim().toLowerCase();
  if (!isHostname(host)) return null;
  let pathPrefix = typeof site.pathPrefix === "string" ? site.pathPrefix.trim() : "";
  if (pathPrefix === "/") pathPrefix = "";
  pathPrefix = pathPrefix.replace(/\/+$/, "");
  if (pathPrefix.endsWith("/*")) pathPrefix = pathPrefix.slice(0, -2).replace(/\/+$/, "");
  if (
    pathPrefix &&
    (!pathPrefix.startsWith("/") ||
      pathPrefix.includes("..") ||
      pathPrefix.includes("?") ||
      pathPrefix.includes("#") ||
      pathPrefix.includes("\\") ||
      pathPrefix.includes("://") ||
      pathPrefix.length > PATH_MAX)
  ) {
    return null;
  }
  const includeSubdomains = site.includeSubdomains === true;
  const label = sanitizeLabel(site.label) || host;
  return {
    id: siteId(host, pathPrefix, includeSubdomains),
    label,
    host,
    pathPrefix,
    includeSubdomains,
  };
}

/**
 * @param {Array<object>|null|undefined} sites
 * @returns {Array<object>}
 */
export function normalizeSiteList(sites) {
  if (!Array.isArray(sites)) return [];
  const out = [];
  const seen = new Set();
  for (const site of sites) {
    const normalized = normalizeSite(site);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
    if (out.length >= SITE_LIMIT) break;
  }
  return out;
}

const SUGGESTED_INPUT = [
  { label: "freeCodeCamp", host: "freecodecamp.org", pathPrefix: "/learn", includeSubdomains: false },
  { label: "MDN Web Docs", host: "developer.mozilla.org", pathPrefix: "", includeSubdomains: false },
  { label: "javascript.info", host: "javascript.info", pathPrefix: "", includeSubdomains: false },
  { label: "The Odin Project", host: "theodinproject.com", pathPrefix: "", includeSubdomains: false },
  { label: "Khan Academy", host: "khanacademy.org", pathPrefix: "", includeSubdomains: false },
  { label: "Coursera", host: "coursera.org", pathPrefix: "", includeSubdomains: false },
];

/** Sites the learning page can add in one click. None of these are tracked until added, except the default. */
export const SUGGESTED_SITES = normalizeSiteList(SUGGESTED_INPUT);

/** Tracked until the owner saves their own list. Curriculum pages on freeCodeCamp only. */
export const DEFAULT_SITES = SUGGESTED_SITES.filter(
  (site) => site.host === "freecodecamp.org" && site.pathPrefix === "/learn"
);

/**
 * The list to match against.
 *
 * An explicit array on the connection — including an empty one — is the
 * owner's choice. A missing array means the list has never been saved, so the
 * cache or the freeCodeCamp default applies.
 *
 * @param {object} input
 * @param {object|null} [input.serverConfig]
 * @param {Array<object>|null} [input.cachedSites]
 * @param {boolean} [input.cacheKnown]
 * @param {boolean} [input.cacheDirty] a local edit that has not been saved yet wins over the server copy
 * @returns {Array<object>}
 */
export function resolveSites({ serverConfig, cachedSites, cacheKnown, cacheDirty } = {}) {
  if (cacheDirty && cacheKnown) return normalizeSiteList(cachedSites);
  if (serverConfig && Array.isArray(serverConfig.sites)) {
    return normalizeSiteList(serverConfig.sites);
  }
  if (cacheKnown) return normalizeSiteList(cachedSites);
  return DEFAULT_SITES.map((site) => ({ ...site }));
}

/**
 * @param {string} text the host, a URL, or a pattern like `*.example.com/learn`
 * @param {string} [label]
 * @returns {object}
 */
export function parseSiteInput(text, label) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Enter a site, such as freecodecamp.org.");
  if (/\s/.test(raw)) throw new Error("A site pattern cannot contain spaces.");
  if (raw.includes("@")) {
    throw new Error("A site pattern cannot include a username or password.");
  }
  let includeSubdomains = false;
  let body = raw;
  if (body.startsWith("*.")) {
    includeSubdomains = true;
    body = body.slice(2);
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(body) ? body : `https://${body}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("That site pattern could not be read. Use a host such as freecodecamp.org.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https sites can be tracked.");
  }
  if (url.username || url.password) {
    throw new Error("A site pattern cannot include a username or password.");
  }
  if (url.search || url.hash) {
    throw new Error(
      "Query strings and hashes are not part of a site pattern. Enter the host and, if you want, a path prefix."
    );
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("www.") && host.split(".").length > 2) host = host.slice(4);
  if (!isHostname(host)) throw new Error("That host name is not valid.");
  let pathPrefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  if (pathPrefix.endsWith("/*")) pathPrefix = pathPrefix.slice(0, -2).replace(/\/+$/, "");
  const normalized = normalizeSite({
    host,
    pathPrefix,
    includeSubdomains,
    label: label && String(label).trim() ? label : host,
  });
  if (!normalized) throw new Error("That site pattern could not be stored.");
  return normalized;
}

/**
 * @param {string} hostname
 * @param {object} site
 * @returns {boolean}
 */
export function hostMatches(hostname, site) {
  const host = String(hostname ?? "").toLowerCase();
  if (!host || !site?.host) return false;
  if (host === site.host || host === `www.${site.host}`) return true;
  return site.includeSubdomains === true && host.endsWith(`.${site.host}`) && host !== `www.${site.host}`;
}

/**
 * @param {string} pathname
 * @param {string} prefix
 * @returns {boolean}
 */
export function pathMatches(pathname, prefix) {
  if (!prefix) return true;
  const path = pathname || "/";
  if (path === prefix) return true;
  const root = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(root);
}

/**
 * @param {string} value
 * @returns {URL|null}
 */
export function parseHttpUrl(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url;
}

/**
 * @param {URL} url
 * @param {Array<object>} sites
 * @returns {object|null}
 */
export function findSite(url, sites) {
  const list = normalizeSiteList(sites).sort((a, b) => {
    const path = b.pathPrefix.length - a.pathPrefix.length;
    if (path !== 0) return path;
    return Number(a.includeSubdomains) - Number(b.includeSubdomains);
  });
  return list.find((site) => hostMatches(url.hostname, site) && pathMatches(url.pathname, site.pathPrefix)) ?? null;
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isFreecodecampHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return host === "freecodecamp.org" || host === "www.freecodecamp.org" || host.endsWith(".freecodecamp.org");
}

/**
 * freeCodeCamp curriculum URLs are /learn/{course}/{block}/{lesson}.
 * Step challenges keep the block name so "step 12" still says which workshop it is.
 *
 * @param {string} pathname
 * @returns {{courseLabel: string|null, lessonLabel: string|null}}
 */
export function freecodecampLabels(pathname) {
  const parts = String(pathname ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const learnAt = parts.indexOf("learn");
  if (learnAt < 0) return { courseLabel: null, lessonLabel: null };
  const course = parts[learnAt + 1] ? humanizeSlug(parts[learnAt + 1]) : null;
  const block = parts[learnAt + 2] ? humanizeSlug(parts[learnAt + 2]) : null;
  const challenge = parts[learnAt + 3] || "";
  let lesson = null;
  if (challenge && /^step-\d+$/i.test(challenge) && block) {
    lesson = sanitizeTrackLabel(`${block} · ${humanizeSlug(challenge)}`);
  } else if (challenge) {
    lesson = humanizeSlug(challenge);
  } else if (block) {
    lesson = block;
  }
  return { courseLabel: course, lessonLabel: lesson };
}

/**
 * What may be stored for this URL. Null when the page is not on the allowlist.
 * The returned object has no URL.
 *
 * @param {string|null|undefined} urlString
 * @param {Array<object>} sites
 * @param {string|null|undefined} title
 * @returns {object|null}
 */
export function describeTrackedPage(urlString, sites, title) {
  const url = parseHttpUrl(urlString);
  if (!url) return null;
  const site = findSite(url, sites);
  if (!site) return null;
  const extracted = isFreecodecampHost(url.hostname)
    ? freecodecampLabels(url.pathname)
    : { courseLabel: null, lessonLabel: null };
  const pageTitle = sanitizeTitle(title);
  const lessonLabel = extracted.lessonLabel || pageTitle;
  return {
    siteHost: site.host,
    siteLabel: site.label,
    courseLabel: extracted.courseLabel,
    lessonLabel,
    pageTitle,
  };
}

/**
 * The pattern shown in the list.
 *
 * @param {object} site
 * @returns {string}
 */
export function patternText(site) {
  const host = site?.includeSubdomains ? `*.${site.host}` : site?.host || "";
  return site?.pathPrefix ? `${host}${site.pathPrefix}` : host;
}

/**
 * @param {string} userAgent
 * @returns {"firefox"|"edge"|"chrome"|"chromium"}
 */
export function detectBrowser(userAgent) {
  const value = String(userAgent ?? "").toLowerCase();
  if (value.includes("firefox") || value.includes("fxios")) return "firefox";
  if (value.includes("edg/")) return "edge";
  if (value.includes("chrome") || value.includes("chromium") || value.includes("crios")) return "chrome";
  return "chromium";
}

/**
 * @param {string|null|undefined} browser
 * @returns {string}
 */
export function browserLabel(browser) {
  if (browser === "firefox") return "Firefox";
  if (browser === "edge") return "Edge";
  if (browser === "chrome") return "Chrome";
  if (browser === "chromium") return "Chromium";
  return "Browser";
}
