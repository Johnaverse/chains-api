import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time token comparison, per SERVICE-CONTRACT §10.
 *
 * Both sides are hashed first because that is what makes the comparison fixed-length:
 * `timingSafeEqual` throws outright on a length mismatch, so comparing raw strings would both
 * crash on a wrong-length guess and leak the expected length by the shape of the failure.
 * Digests are always 32 bytes, so every wrong guess costs the same.
 *
 * @param {string} expected the configured token; falsy means no token is configured
 * @param {unknown} provided whatever arrived on the request
 * @returns {boolean} true only when a token is configured and the two match
 */
export function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}
