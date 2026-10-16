import { describe, it, expect } from 'vitest';
import { tokenMatches } from '../../../src/util/token.js';

describe('tokenMatches', () => {
  it('accepts the configured token', () => {
    expect(tokenMatches('s3cret', 's3cret')).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(tokenMatches('s3cret', 'foobar')).toBe(false);
  });

  it('rejects a wrong token of a DIFFERENT length without throwing', () => {
    // The reason both sides are hashed first: timingSafeEqual throws outright on a length
    // mismatch, so a raw comparison would turn a wrong-length guess into a 500 and leak the
    // expected length through the shape of the failure.
    expect(() => tokenMatches('s3cret', 'x')).not.toThrow();
    expect(tokenMatches('s3cret', 'x')).toBe(false);
    expect(tokenMatches('s3cret', 's3cret-plus-a-lot-more')).toBe(false);
  });

  it('refuses everything when no token is configured', () => {
    // §10's closed-by-default posture: an unset token must never be satisfiable, least of all
    // by sending nothing.
    for (const expected of ['', null, undefined]) {
      expect(tokenMatches(expected, '')).toBe(false);
      expect(tokenMatches(expected, 'anything')).toBe(false);
    }
  });

  it('refuses a missing or non-string provided value', () => {
    for (const provided of [undefined, null, '', 123, {}, ['s3cret']]) {
      expect(tokenMatches('s3cret', provided)).toBe(false);
    }
  });
});
