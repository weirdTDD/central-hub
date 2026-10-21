// Central Hub — stable identifiers: a deterministic hash and UUID-shaped ids.
//
// WHY this module exists: several domains need an id that is the SAME for the same
// input on every machine and every run — the idempotency key of an imported
// observation, of a workflow run, of a notification. That is what makes repeated
// work a no-op instead of a duplicate.
//
// WHY a stable hash and not a cryptographic digest: the id only has to be
// reproducible. It never guards a secret, never proves authorship and never
// authenticates anything, so a fast non-cryptographic hash is the right tool.
//
// This module is deliberately PURE (no React, no network, no browser APIs) so the
// rules can be verified with plain Node assertions — see scripts/verify-*.mjs.

/** FNV-1a 64-bit prime. */
const FNV_PRIME_64 = 0x100000001b3n;

/** Standard FNV-1a 64-bit offset basis — the first of the two hash lanes. */
const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;

/**
 * Second offset basis (the 64-bit golden-ratio constant).
 *
 * FNV-1a 128 is defined with a wider prime; running the 64-bit hash from two
 * different bases is the closest pure-JavaScript equivalent and keeps the full
 * 128-bit width, so two different inputs cannot collapse onto one id by accident.
 */
const FNV_OFFSET_BASIS_64_ALT = 0x9e3779b97f4a7c15n;

/** Keeps the multiplication inside 64 bits (FNV-1a is defined modulo 2^64). */
const MASK_64 = (1n << 64n) - 1n;

/**
 * Encodes a string as UTF-8 bytes.
 *
 * Written out by hand instead of using `TextEncoder` so the module stays free of
 * any environment-specific global and produces identical bytes everywhere.
 *
 * @param {string} text
 * @returns {number[]} the UTF-8 bytes of the text
 */
function utf8Bytes(text) {
  const bytes = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return bytes;
}

/**
 * FNV-1a over the bytes, from a given offset basis.
 *
 * @param {number[]} bytes
 * @param {bigint} offsetBasis
 * @returns {bigint} the 64-bit hash
 */
function fnv1a64(bytes, offsetBasis) {
  let hash = offsetBasis;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME_64) & MASK_64;
  }
  return hash;
}

/**
 * Renders a 64-bit hash as 16 lowercase hex characters.
 *
 * @param {bigint} value
 * @returns {string}
 */
function toHex64(value) {
  return value.toString(16).padStart(16, "0");
}

/**
 * A deterministic 128-bit hash of any value, as 32 lowercase hex characters.
 *
 * NON-CRYPTOGRAPHIC: it is a stable identifier, not a security primitive. It is
 * used only to build idempotency keys, where the property that matters is "the
 * same input always produces the same output" — across reloads, machines and
 * processes. Never use it for passwords, tokens, signatures or integrity checks
 * against an attacker.
 *
 * The hash is FNV-1a 64-bit run from two different offset bases, concatenated, so
 * the result carries 128 bits of width.
 *
 * @param {string|number|boolean|null|undefined} input the value to hash; null and
 *   undefined are treated as the empty string
 * @returns {string} 32 lowercase hex characters
 */
export function stableHash(input) {
  const text = input === null || input === undefined ? "" : String(input);
  const bytes = utf8Bytes(text);
  const first = fnv1a64(bytes, FNV_OFFSET_BASIS_64);
  const second = fnv1a64(bytes, FNV_OFFSET_BASIS_64_ALT);
  return toHex64(first) + toHex64(second);
}

/**
 * A deterministic, UUID-shaped identifier for a value.
 *
 * WHY a UUID: the client-generated ids are `uuid` primary keys that double as the
 * idempotency key, so re-sending the same record must collide on the primary key
 * instead of creating a second row. The value therefore has to be a valid `uuid`
 * for Postgres while still being reproducible from the record alone.
 *
 * The 32 hex characters come from `stableHash`, formatted 8-4-4-4-12. The version
 * nibble is set to 5 and the variant nibble to one of 8/9/a/b, so the result
 * matches the UUID shape the database expects. Note that the digest itself is the
 * repository's FNV-1a-based stable hash and NOT the SHA-1 of RFC 4122: this is a
 * UUID-shaped deterministic id, not an RFC 4122 version 5 UUID.
 *
 * @param {string|number|boolean|null|undefined} input the value to derive the id from
 * @returns {string} "xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx"
 */
export function deterministicUuid(input) {
  const hex = stableHash(input);
  const variant = "89ab"[parseInt(hex[16], 16) & 0x3];
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
