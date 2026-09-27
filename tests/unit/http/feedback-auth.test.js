import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../../index.js';
import { _resetFeedbackForTests } from '../../../src/services/feedback.js';
import { createAuth, parseAllowlist, allowedOrigins, _setAuthForTests } from '../../../src/services/auth/index.js';
import { createAuthStore } from '../../../src/services/auth/store.js';
import { createChallengeService } from '../../../src/services/auth/challenges.js';
import { createMailer } from '../../../src/services/auth/mailer.js';

// feedback.test.js covers the endpoint with accounts OFF — the default, where nothing changes.
// This file covers accounts ON, where reading reports needs a session and submitting does not.

let app;
let dir;
let store;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'feedback-auth-'));
  store = createAuthStore({ file: join(dir, 'auth.json') });
  _setAuthForTests(createAuth({
    enabled: true,
    allowlist: parseAllowlist('owner@x.io'),
    appUrl: 'https://app.test/',
    origins: allowedOrigins('https://app.test/', ''),
    sessionTtlMs: 86400000,
    cookieSecure: true,
    store,
    challenges: createChallengeService(),
    mailer: createMailer({ transport: { sendMail: async () => {} }, from: 'x@x.io' })
  }));
  app = await buildApp({ logger: false, loadDataOnStartup: false });
});
afterAll(async () => {
  await app.close();
  _setAuthForTests(null);
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => _resetFeedbackForTests());

async function ownerCookie() {
  const user = await store.createUser('owner@x.io');
  const { token } = await store.createSession(user.id, 86400000);
  return `chains_session=${token}`;
}

describe('GET /feedback with accounts on', () => {
  it('refuses an anonymous reader', async () => {
    const res = await app.inject({ method: 'GET', url: '/feedback' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/Sign in/);
  });

  it('refuses a forged session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/feedback', headers: { cookie: 'chains_session=forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('serves a signed-in reviewer', async () => {
    const res = await app.inject({ method: 'GET', url: '/feedback', headers: { cookie: await ownerCookie() } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('feedback');
  });

  it('keeps SUBMITTING anonymous — flagging a wrong link needs no account', async () => {
    const res = await app.inject({
      method: 'POST', url: '/feedback', payload: { kind: 'incident', reason: 'not_related' }
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('the real app with accounts on', () => {
  it('registers the /auth routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/session' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authenticated: false });
  });

  it('grants credentialed CORS to the dashboard origin only', async () => {
    const ok = await app.inject({ method: 'GET', url: '/auth/session', headers: { origin: 'https://app.test' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.test');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const foreign = await app.inject({ method: 'GET', url: '/auth/session', headers: { origin: 'https://evil.test' } });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('leaves the rest of the API on its old CORS policy for other origins', async () => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://anyone.test' } });
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
