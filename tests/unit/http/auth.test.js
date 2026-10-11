import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import ajvErrors from 'ajv-errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authRoutes } from '../../../src/http/routes/auth.js';
import { createAuth, parseAllowlist, allowedOrigins } from '../../../src/services/auth/index.js';
import { createAuthStore } from '../../../src/services/auth/store.js';
import { createChallengeService } from '../../../src/services/auth/challenges.js';
import { createMailer } from '../../../src/services/auth/mailer.js';

const APP_URL = 'https://app.test/chains-api/';
const APP_ORIGIN = 'https://app.test';
const DAY = 24 * 60 * 60 * 1000;
const GOOD_PW = 'correct horse battery staple';

let dir;
let outbox;
let transport;
let auth;
let app;

async function build({ enabled = true, allow = 'owner@x.io, @team.io' } = {}) {
  outbox = [];
  transport = { sendMail: async (msg) => { outbox.push(msg); } };
  auth = createAuth({
    enabled,
    allowlist: parseAllowlist(allow),
    appUrl: APP_URL,
    origins: allowedOrigins(APP_URL, ''),
    sessionTtlMs: 30 * DAY,
    cookieSecure: true,
    store: createAuthStore({ file: join(dir, 'auth.json') }),
    challenges: createChallengeService(),
    mailer: createMailer({ transport, from: 'Chains <no-reply@x.io>' })
  });
  // The production AJV options (src/http/app.js). Fastify's default strips unknown keys
  // instead of rejecting them, which would make the schema tests assert fiction.
  app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: 'array', allErrors: true }, plugins: [ajvErrors] }
  });
  await app.register(authRoutes, { auth });
  await app.ready();
  return app;
}

/** Mail goes out after the response, by design — wait for it rather than assume. */
async function mail(count = 1) {
  for (let i = 0; i < 100 && outbox.length < count; i++) await new Promise((r) => setImmediate(r));
  return outbox;
}
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

const codeIn = (msg) => /(\d{6})$/.exec(msg.subject)?.[1];
const tokenIn = (msg, kind) => new RegExp(`#${kind}=([A-Za-z0-9_-]+)`).exec(msg.text)?.[1];
const cookieOf = (res) => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
};
const sessionHeader = (res) => cookieOf(res).split(';')[0];

const post = (url, payload, headers = {}) => app.inject({ method: 'POST', url, payload, headers });
const session = (cookie) => app.inject({ method: 'GET', url: '/auth/session', headers: cookie ? { cookie } : {} });

async function signInWithCode(email = 'owner@x.io', password) {
  const start = await post('/auth/login/start', password ? { email, password } : { email });
  const [msg] = (await mail(outbox.length + 1)).slice(-1);
  const res = await post('/auth/login/verify', { attemptId: start.json().attemptId, code: codeIn(msg) });
  return { start, res, cookie: sessionHeader(res) };
}

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'auth-routes-')); });
afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('closed by default', () => {
  it('registers nothing when auth is not configured — every path is a plain 404', async () => {
    await build({ enabled: false });
    expect((await post('/auth/login/start', { email: 'owner@x.io' })).statusCode).toBe(404);
    expect((await session()).statusCode).toBe(404);
  });
});

describe('passwordless sign-in (the Claude-style path)', () => {
  beforeEach(() => build());

  it('emails a code and a link, and answers with an attempt id for this window only', async () => {
    const res = await post('/auth/login/start', { email: 'Owner@X.io' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ attemptId: expect.any(String), expiresAt: expect.any(String), next: 'code' });

    const [msg] = await mail();
    expect(msg.to).toBe('owner@x.io');
    expect(codeIn(msg)).toMatch(/^\d{6}$/);
    expect(msg.text).toContain(`${APP_URL}login.html#verify=`);
    // The attempt id is for the requesting window, never for the inbox.
    expect(msg.text).not.toContain(res.json().attemptId);
  });

  it('finishes with the code, creates the account, and sets a hardened session cookie', async () => {
    const { res, cookie } = await signInWithCode();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: true, user: { email: 'owner@x.io', hasPassword: false } });

    const set = cookieOf(res);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(set).toContain(attr);
    expect(set).toMatch(/Max-Age=2592000/);

    const who = await session(cookie);
    expect(who.json()).toMatchObject({ authenticated: true, user: { email: 'owner@x.io' } });
  });

  it('finishes with the magic link, signing in the browser that follows it', async () => {
    await post('/auth/login/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    const res = await post('/auth/login/link', { token: tokenIn(msg, 'verify') });
    expect(res.statusCode).toBe(200);
    expect((await session(sessionHeader(res))).json().authenticated).toBe(true);
  });

  it('allows a whole domain from the allowlist, but not a lookalike', async () => {
    expect((await signInWithCode('bob@team.io')).res.statusCode).toBe(200);
    await post('/auth/login/start', { email: 'eve@evilteam.io' });
    await settle();
    expect(outbox.filter((m) => m.to === 'eve@evilteam.io')).toHaveLength(0);
  });

  it('refuses the right code without the right attempt id', async () => {
    await post('/auth/login/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    const res = await post('/auth/login/verify', { attemptId: 'not-this-window', code: codeIn(msg) });
    expect(res.statusCode).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('gives one generic message for wrong, locked and expired, then refuses even the right code', async () => {
    const start = await post('/auth/login/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    const wrong = codeIn(msg) === '000000' ? '111111' : '000000';
    const messages = new Set();
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/login/verify', { attemptId: start.json().attemptId, code: wrong });
      expect(r.statusCode).toBe(400);
      messages.add(r.json().error);
    }
    expect(messages.size).toBe(1);
    const late = await post('/auth/login/verify', { attemptId: start.json().attemptId, code: codeIn(msg) });
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe([...messages][0]);
  });

  it('will not finish for an address removed from the allowlist while its code was in flight', async () => {
    const start = await post('/auth/login/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    auth.allowlist.emails.delete('owner@x.io');
    const res = await post('/auth/login/verify', { attemptId: start.json().attemptId, code: codeIn(msg) });
    expect(res.statusCode).toBe(400);
  });
});

describe('what an outsider cannot learn', () => {
  beforeEach(() => build());

  it('answers every email-only request identically: new, existing, outsider, or password account', async () => {
    // An existing passwordless account, and an account with a password.
    await signInWithCode('owner@x.io');
    const withPw = await signInWithCode('bob@team.io');
    await post('/auth/password', { newPassword: GOOD_PW }, { cookie: withPw.cookie });
    await settle();
    outbox.length = 0;

    const cases = ['new@team.io', 'owner@x.io', 'outsider@elsewhere.io', 'bob@team.io'];
    const shapes = [];
    for (const e of cases) {
      const r = await post('/auth/login/start', { email: e });
      expect(r.statusCode).toBe(202);
      shapes.push(Object.keys(r.json()).sort().join(','));
      expect(r.json().next).toBe('code');
    }
    expect(new Set(shapes).size).toBe(1);

    await settle();
    const to = (e) => outbox.filter((m) => m.to === e);
    expect(to('outsider@elsewhere.io')).toHaveLength(0);
    // The password account is told, privately, to use its password — and gets no code.
    const [notice] = to('bob@team.io');
    expect(notice.subject).toMatch(/password/);
    expect(codeIn(notice)).toBeUndefined();
  });

  it('never makes the response wait on email delivery, so latency cannot tell cases apart', async () => {
    transport.sendMail = () => new Promise(() => {}); // an SMTP server that never answers
    const t0 = Date.now();
    const res = await post('/auth/login/start', { email: 'owner@x.io' });
    expect(res.statusCode).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('still answers 202 when the SMTP server fails, and logs no secret', async () => {
    transport.sendMail = async () => { throw new Error('SMTP down'); };
    const res = await post('/auth/login/start', { email: 'owner@x.io' });
    expect(res.statusCode).toBe(202);
    await settle();
  });

  it('keeps answering 202 once an address is over its send budget, but sends nothing more', async () => {
    for (let i = 0; i < 5; i++) await post('/auth/login/start', { email: 'owner@x.io' });
    await mail(5);
    const over = await post('/auth/login/start', { email: 'owner@x.io' });
    expect(over.statusCode).toBe(202);
    await settle();
    expect(outbox).toHaveLength(5);
  });
});

describe('password as a first factor (the email step still finishes sign-in)', () => {
  let ownerCookie;
  beforeEach(async () => {
    await build();
    ownerCookie = (await signInWithCode('owner@x.io')).cookie;
    await post('/auth/password', { newPassword: GOOD_PW }, { cookie: ownerCookie });
    await settle();
    outbox.length = 0;
  });

  it('a correct password still has to be finished with the emailed code', async () => {
    const start = await post('/auth/login/start', { email: 'owner@x.io', password: GOOD_PW });
    expect(start.statusCode).toBe(202);
    expect(start.headers['set-cookie']).toBeUndefined(); // not signed in yet

    const [msg] = await mail();
    const res = await post('/auth/login/verify', { attemptId: start.json().attemptId, code: codeIn(msg) });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.hasPassword).toBe(true);
  });

  it('gives the same 401 for a wrong password, an unknown address and an outsider', async () => {
    const replies = await Promise.all([
      post('/auth/login/start', { email: 'owner@x.io', password: 'wrong password entirely' }),
      post('/auth/login/start', { email: 'nobody@team.io', password: GOOD_PW }),
      post('/auth/login/start', { email: 'outsider@elsewhere.io', password: GOOD_PW })
    ]);
    for (const r of replies) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe('Incorrect email or password.');
    }
    await settle();
    expect(outbox).toHaveLength(0);
  });

  it('upgrades a hash made with weaker parameters on the next correct password', async () => {
    const user = await auth.store.findUserByEmail('owner@x.io');
    // A genuine legacy hash, derived at ln=14 — so it verifies, and is below today's cost.
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16);
    const key = scryptSync(GOOD_PW.normalize('NFKC'), salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const b64 = (b) => b.toString('base64').replace(/=+$/, '');
    await auth.store.setPasswordHash(user.id, `$scrypt$ln=14,r=8,p=1$${b64(salt)}$${b64(key)}`);

    const r = await post('/auth/login/start', { email: 'owner@x.io', password: GOOD_PW });
    expect(r.statusCode).toBe(202);
    expect((await auth.store.findUserByEmail('owner@x.io')).passwordHash).toContain('ln=15');
  });
});

describe('setting and changing a password', () => {
  beforeEach(() => build());

  it('requires a session', async () => {
    const r = await post('/auth/password', { newPassword: GOOD_PW });
    expect(r.statusCode).toBe(401);
  });

  it('enforces the length policy', async () => {
    const { cookie } = await signInWithCode();
    const r = await post('/auth/password', { newPassword: 'short' }, { cookie });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at least 12/);
  });

  it('sets a first password without a current one, stores only a salted hash, and sends a notice', async () => {
    const { cookie } = await signInWithCode();
    await settle();
    outbox.length = 0;
    const r = await post('/auth/password', { newPassword: GOOD_PW }, { cookie });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.hasPassword).toBe(true);

    const stored = (await auth.store.findUserByEmail('owner@x.io')).passwordHash;
    expect(stored).toMatch(/^\$scrypt\$/);
    expect(stored).not.toContain(GOOD_PW);

    const [notice] = await mail();
    expect(notice.subject).toMatch(/password was changed/);
  });

  it('changing an existing password needs the current one', async () => {
    const { cookie } = await signInWithCode();
    await post('/auth/password', { newPassword: GOOD_PW }, { cookie });
    const wrong = await post('/auth/password', { currentPassword: 'not it at all!', newPassword: 'another long passphrase' }, { cookie });
    expect(wrong.statusCode).toBe(401);
    const right = await post('/auth/password', { currentPassword: GOOD_PW, newPassword: 'another long passphrase' }, { cookie });
    expect(right.statusCode).toBe(200);
  });

  it('signs out every other session but keeps the one that made the change', async () => {
    const a = await signInWithCode();
    const b = await signInWithCode();
    await post('/auth/password', { newPassword: GOOD_PW }, { cookie: a.cookie });
    expect((await session(a.cookie)).json().authenticated).toBe(true);
    expect((await session(b.cookie)).json().authenticated).toBe(false);
  });
});

describe('password reset', () => {
  let oldCookie;
  beforeEach(async () => {
    await build();
    oldCookie = (await signInWithCode('owner@x.io')).cookie;
    await post('/auth/password', { newPassword: GOOD_PW }, { cookie: oldCookie });
    await settle();
    outbox.length = 0;
  });

  it('answers 202 identically for an account, an unknown address and an outsider — and only the account gets mail', async () => {
    const replies = await Promise.all(['owner@x.io', 'nobody@team.io', 'outsider@elsewhere.io']
      .map((e) => post('/auth/password/reset/start', { email: e })));
    for (const r of replies) {
      expect(r.statusCode).toBe(202);
      expect(Object.keys(r.json()).sort()).toEqual(['attemptId', 'expiresAt', 'next']);
    }
    await settle();
    expect(outbox.map((m) => m.to)).toEqual(['owner@x.io']);
    expect(outbox[0].subject).toMatch(/password reset code: \d{6}$/);
  });

  it('resets with the code: new password works, every old session is gone, this browser is signed in', async () => {
    const start = await post('/auth/password/reset/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    const res = await post('/auth/password/reset/complete', {
      attemptId: start.json().attemptId, code: codeIn(msg), newPassword: 'a brand new passphrase'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authenticated).toBe(true);
    expect((await session(oldCookie)).json().authenticated).toBe(false);
    expect((await session(sessionHeader(res))).json().authenticated).toBe(true);

    // The old password no longer starts a sign-in; the new one does.
    expect((await post('/auth/login/start', { email: 'owner@x.io', password: GOOD_PW })).statusCode).toBe(401);
    expect((await post('/auth/login/start', { email: 'owner@x.io', password: 'a brand new passphrase' })).statusCode).toBe(202);
  });

  it('resets with the link token', async () => {
    await post('/auth/password/reset/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    const res = await post('/auth/password/reset/complete', { token: tokenIn(msg, 'reset'), newPassword: 'a brand new passphrase' });
    expect(res.statusCode).toBe(200);
  });

  it('a new password that fails policy does not burn the code', async () => {
    const start = await post('/auth/password/reset/start', { email: 'owner@x.io' });
    const [msg] = await mail();
    const body = { attemptId: start.json().attemptId, code: codeIn(msg) };
    expect((await post('/auth/password/reset/complete', { ...body, newPassword: 'short' })).statusCode).toBe(400);
    expect((await post('/auth/password/reset/complete', { ...body, newPassword: 'long enough this time' })).statusCode).toBe(200);
  });

  it('a sign-in code cannot complete a reset', async () => {
    const start = await post('/auth/login/start', { email: 'owner@x.io', password: GOOD_PW });
    const [msg] = await mail();
    const res = await post('/auth/password/reset/complete', {
      attemptId: start.json().attemptId, code: codeIn(msg), newPassword: 'a brand new passphrase'
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('session and sign-out', () => {
  beforeEach(() => build());

  it('reports signed-out with 200, not an error', async () => {
    const r = await session();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ authenticated: false });
  });

  it('treats a forged cookie as signed out', async () => {
    expect((await session('chains_session=forged')).json().authenticated).toBe(false);
  });

  it('signs out: the session is revoked server-side and the cookie is cleared', async () => {
    const { cookie } = await signInWithCode();
    const out = await post('/auth/logout', {}, { cookie });
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out)).toMatch(/Max-Age=0/);
    expect((await session(cookie)).json().authenticated).toBe(false);
  });

  it('signing out with no session still clears the cookie', async () => {
    const out = await post('/auth/logout', {});
    expect(out.statusCode).toBe(204);
  });
});

describe('CSRF: the Origin check', () => {
  beforeEach(() => build());

  it('refuses a POST from a foreign origin', async () => {
    const r = await post('/auth/login/start', { email: 'owner@x.io' }, { origin: 'https://evil.test' });
    expect(r.statusCode).toBe(403);
    await settle();
    expect(outbox).toHaveLength(0);
  });

  it('refuses a POST whose Origin is the literal "null" (sandboxed frames, file://)', async () => {
    expect((await post('/auth/logout', {}, { origin: 'null' })).statusCode).toBe(403);
  });

  it('refuses a cross-site POST that arrives without an Origin header', async () => {
    const r = await post('/auth/logout', {}, { 'sec-fetch-site': 'cross-site' });
    expect(r.statusCode).toBe(403);
  });

  it('accepts the dashboard origin and the API\'s own origin', async () => {
    expect((await post('/auth/login/start', { email: 'owner@x.io' }, { origin: APP_ORIGIN })).statusCode).toBe(202);
    expect((await post('/auth/logout', {}, { origin: 'http://localhost:80' })).statusCode).toBe(204);
  });

  it('accepts a non-browser client that sends no Origin', async () => {
    expect((await post('/auth/login/start', { email: 'owner@x.io' })).statusCode).toBe(202);
  });

  it('never blocks a GET on origin', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/session', headers: { origin: 'https://evil.test' } });
    expect(r.statusCode).toBe(200);
  });
});

describe('input validation', () => {
  beforeEach(() => build());

  it('rejects a malformed address before it reaches the mailer', async () => {
    for (const email of ['not-an-email', 'a@b', 'a@@x.io', 'a b@x.io', 'x@y.io, z@w.io', '"q"@x.io', '.a@x.io', 'a..b@x.io']) {
      const r = await post('/auth/login/start', { email });
      expect(r.statusCode, email).toBe(400);
    }
    await settle();
    expect(outbox).toHaveLength(0);
  });

  it('rejects an unknown body field', async () => {
    expect((await post('/auth/login/start', { email: 'owner@x.io', admin: true })).statusCode).toBe(400);
  });

  it('rejects an over-long field at the schema', async () => {
    expect((await post('/auth/login/start', { email: `${'a'.repeat(250)}@x.io` })).statusCode).toBe(400);
  });
});
