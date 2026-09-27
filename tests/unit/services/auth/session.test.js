import { describe, it, expect } from 'vitest';
import {
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  sessionTokenFrom,
  readSession,
  publicUser,
  SESSION_COOKIE
} from '../../../../src/services/auth/session.js';

describe('cookies', () => {
  it('parses a Cookie header, decoding values and taking the first of duplicates', () => {
    expect(parseCookies('a=1; b=hello%20world; a=2; c="quoted"; junk; =nameless')).toEqual({
      a: '1', b: 'hello world', c: 'quoted'
    });
  });

  it('survives a malformed percent-encoding instead of throwing', () => {
    expect(parseCookies('a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
  });

  it('returns nothing for a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('issues an HttpOnly, SameSite=Lax session cookie with the TTL as Max-Age', () => {
    const c = sessionCookie('tok', { ttlMs: 3600 * 1000, secure: true });
    expect(c).toBe(`${SESSION_COOKIE}=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure`);
  });

  it('omits Secure only when told to (plain-http local development)', () => {
    expect(sessionCookie('tok', { ttlMs: 1000, secure: false })).not.toContain('Secure');
  });

  it('clears with Max-Age=0', () => {
    expect(clearSessionCookie({ secure: true })).toMatch(/Max-Age=0/);
  });

  it('reads the session token from a request', () => {
    expect(sessionTokenFrom({ headers: { cookie: `x=1; ${SESSION_COOKIE}=abc` } })).toBe('abc');
    expect(sessionTokenFrom({ headers: {} })).toBeNull();
  });
});

describe('readSession', () => {
  const req = (cookie) => ({ headers: cookie ? { cookie } : {} });

  it('is null when auth is off, whatever the cookie says', async () => {
    expect(await readSession(req(`${SESSION_COOKIE}=abc`), { enabled: false })).toBeNull();
  });

  it('is null with no cookie', async () => {
    expect(await readSession(req(), { enabled: true, store: {} })).toBeNull();
  });

  it('returns the session with its token when the store knows it', async () => {
    const store = { getSession: async (t) => (t === 'abc' ? { session: { id: 1 }, user: { email: 'a@x.io' } } : null) };
    const s = await readSession(req(`${SESSION_COOKIE}=abc`), { enabled: true, store });
    expect(s).toMatchObject({ token: 'abc', user: { email: 'a@x.io' } });
  });

  it('reads a broken store as signed out, not as a 500 on every protected route', async () => {
    const store = { getSession: async () => { throw new Error('disk gone'); } };
    expect(await readSession(req(`${SESSION_COOKIE}=abc`), { enabled: true, store })).toBeNull();
  });
});

describe('publicUser', () => {
  it('exposes a password FLAG, never the hash', () => {
    const out = publicUser({ id: 'u', email: 'a@x.io', passwordHash: '$scrypt$secret', createdAt: 'c' });
    expect(out).toEqual({ email: 'a@x.io', hasPassword: true, createdAt: 'c', lastLoginAt: null });
    expect(JSON.stringify(out)).not.toContain('scrypt');
    expect(out).not.toHaveProperty('id');
  });
});
