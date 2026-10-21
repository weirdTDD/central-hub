/**
 * Local avatar generation.
 *
 * The avatar is rendered in the browser from an inline SVG data URI. No account
 * identifier (email address) is ever sent to a third-party avatar service, so the
 * app does not disclose who is using it.
 */

/**
 * The palette the avatar background is drawn from.
 *
 * Each entry is a design token, so the avatar follows the blue ramp
 * instead of the neutral theme primary, which flips between light and dark.
 * The token is resolved to a concrete colour because the avatar is an SVG data
 * URI, which is a separate document and cannot inherit the page's CSS
 * variables.
 */
const PALETTE_TOKENS = ["--blue-black", "--blue-800", "--blue-700", "--blue-600"];
const PALETTE_FALLBACKS = ["#0b1c33", "#1e3a8a", "#1d4ed8", "#2563eb"];

/**
 * Resolves a CSS custom property to a concrete colour.
 *
 * @param {string} token the custom property name
 * @param {string} fallback the value to use when it cannot be resolved
 * @returns {string}
 */
function readToken(token, fallback) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  return value || fallback;
}

/**
 * The initials shown on an avatar.
 *
 * @param {string} name
 * @returns {string} up to two upper-case letters
 */
export function initialsOf(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

/**
 * A deterministic background colour for a name, so the same person always gets the
 * same colour without storing anything.
 */
function colorFor(name) {
  const text = String(name ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  const index = hash % PALETTE_TOKENS.length;
  return readToken(PALETTE_TOKENS[index], PALETTE_FALLBACKS[index]);
}

/**
 * Builds an inline SVG avatar with the person's initials.
 *
 * @param {string} name
 * @param {number} [size] pixel size of the square image
 * @returns {string} a `data:` URI usable as an <img> source
 */
export function initialsAvatar(name = "You", size = 150) {
  const initials = initialsOf(name);
  const color = colorFor(name);
  const textColor = "#ffffff";
  const escaped = initials.replace(/[<>&"']/g, "");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 150 150" role="img" aria-label="${escaped}"><rect width="150" height="150" rx="75" fill="${color}"/><text x="75" y="75" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="60" font-weight="600" fill="${textColor}">${escaped}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * The avatar for the signed-in user.
 *
 * @param {object|null|undefined} authUser a Supabase user object
 * @returns {string} a `data:` URI
 */
export function avatarFor(authUser) {
  const name =
    authUser?.user_metadata?.full_name || authUser?.email || "You";
  return initialsAvatar(name);
}
