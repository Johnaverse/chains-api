import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import ajvErrors from 'ajv-errors';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminConflictRoutes } from '../../../src/http/routes/adminConflicts.js';
import { createAuth, parseAllowlist, allowedOrigins } from '../../../src/services/auth/index.js';
import { createAuthStore } from '../../../src/services/auth/store.js';
import { createChallengeService } from '../../../src/services/auth/challenges.js';
import { createConflictService } from '../../../src/services/conflicts/index.js';
import { createReviewStore } from '../../../src/services/conflicts/reviewStore.js';
import { conflictId } from '../../../src/services/conflicts/identity.js';

const APP = 'https://app.test/';
const conflict = {
  rule: 13, chainId: 56, chainName: 'BNB Smart Chain', type: 'name_disagreement',
  message: 'names differ', chainsName: 'BNB Smart Chain', theGraphName: 'BSC'
};
const ID = conflictId(conflict);

let dir;
let app;
let cookie;
let validate;

async function build({ enabled = true } = {}) {
  const authStore = createAuthStore({ file: join(dir, 'auth.json') });
  const auth = createAuth({
    enabled, allowlist: parseAllowlist('owner@x.io'), appUrl: APP, origins: allowedOrigins(APP, ''),
    sessionTtlMs: 86400000, cookieSecure: true, store: authStore, challenges: createChallengeService(),
    mailer: { }
  });
  validate = () => ({ totalErrors: 1, allErrors: [conflict] });
  const conflicts = createConflictService({ store: createReviewStore({ file: join(dir, 'reviews.json') }), validate: () => validate() });
  app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: 'array', allErrors: true }, plugins: [ajvErrors] }
  });
  await app.register(adminConflictRoutes, { auth, conflicts });
  await app.ready();
  if (enabled) {
    const user = await authStore.createUser('owner@x.io');
    const { token } = await authStore.createSession(user.id, 86400000);
    cookie = `chains_session=${token}`;
  }
}

const get = (url, headers = { cookie }) => app.inject({ method: 'GET', url, headers });
const post = (url, payload, headers = { cookie }) => app.inject({ method: 'POST', url, payload, headers });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'admin-conflicts-')); });
afterEach(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('admin conflict routes', () => {
  describe('access', () => {
    it('registers nothing when accounts are off', async () => {
      await build({ enabled: false });
      expect((await get('/admin/conflicts', {})).statusCode).toBe(404);
    });

    it('refuses an anonymous request, read or write', async () => {
      await build();
      expect((await get('/admin/conflicts', {})).statusCode).toBe(401);
      expect((await post(`/admin/conflicts/${ID}/review`, { state: 'acknowledged' }, {})).statusCode).toBe(401);
      expect((await get('/admin/conflicts/history', {})).statusCode).toBe(401);
    });

    it('refuses a forged session', async () => {
      await build();
      expect((await get('/admin/conflicts', { cookie: 'chains_session=forged' })).statusCode).toBe(401);
    });

    it('refuses a write from a foreign origin even with a valid session (CSRF)', async () => {
      await build();
      const r = await post(`/admin/conflicts/${ID}/review`, { state: 'acknowledged' }, { cookie, origin: 'https://evil.test' });
      expect(r.statusCode).toBe(403);
      expect((await get('/admin/conflicts?state=acknowledged')).json().items).toHaveLength(0);
    });

    it('accepts a write from the dashboard origin', async () => {
      await build();
      const r = await post(`/admin/conflicts/${ID}/review`, { state: 'acknowledged' }, { cookie, origin: 'https://app.test' });
      expect(r.statusCode).toBe(200);
    });
  });

  describe('the review queue', () => {
    beforeEach(() => build());

    it('lists open conflicts with counts and evidence', async () => {
      const r = await get('/admin/conflicts');
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.counts).toMatchObject({ open: 1, total: 1 });
      expect(body.items[0]).toMatchObject({ id: ID, ruleLabel: 'Sources disagree on the network name', evidence: { theGraphName: 'BSC' } });
    });

    it('dismisses with a note, records the admin, and appears in the history', async () => {
      const r = await post(`/admin/conflicts/${ID}/review`, { state: 'dismissed', note: 'BSC is a common alias' });
      expect(r.statusCode).toBe(200);
      expect(r.json().review).toMatchObject({ state: 'dismissed', by: 'owner@x.io', note: 'BSC is a common alias' });
      const h = (await get('/admin/conflicts/history')).json().history;
      expect(h[0]).toMatchObject({ action: 'dismissed', by: 'owner@x.io', chainName: 'BNB Smart Chain' });
    });

    it('rejects a dismissal without a reason', async () => {
      const r = await post(`/admin/conflicts/${ID}/review`, { state: 'dismissed' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/why/);
    });

    it('answers 404 for a conflict that no longer occurs', async () => {
      const r = await post(`/admin/conflicts/${'a'.repeat(20)}/review`, { state: 'acknowledged' });
      expect(r.statusCode).toBe(404);
    });

    it('prunes decisions whose conflict was fixed upstream', async () => {
      await post(`/admin/conflicts/${ID}/review`, { state: 'acknowledged', note: 'reported' });
      validate = () => ({ totalErrors: 0, allErrors: [] });
      expect((await get('/admin/conflicts')).json().counts.resolved).toBe(1);
      const r = await post('/admin/conflicts/prune-resolved', {});
      expect(r.json()).toEqual({ pruned: 1 });
    });

    it('answers 503 while data has not loaded', async () => {
      validate = () => ({ error: 'Data not loaded. Please reload data sources first.' });
      const r = await get('/admin/conflicts');
      expect(r.statusCode).toBe(503);
      expect((await post('/admin/conflicts/prune-resolved', {})).statusCode).toBe(503);
      expect((await post(`/admin/conflicts/${ID}/review`, { state: 'acknowledged' })).statusCode).toBe(503);
    });
  });

  describe('input validation', () => {
    beforeEach(() => build());

    it('rejects a malformed conflict id', async () => {
      expect((await post('/admin/conflicts/not-an-id/review', { state: 'acknowledged' })).statusCode).toBe(400);
    });

    it('rejects an unknown state, an unknown query key, and an over-long note', async () => {
      expect((await post(`/admin/conflicts/${ID}/review`, { state: 'hidden' })).statusCode).toBe(400);
      expect((await get('/admin/conflicts?stat=open')).statusCode).toBe(400);
      expect((await post(`/admin/conflicts/${ID}/review`, { state: 'acknowledged', note: 'x'.repeat(1001) })).statusCode).toBe(400);
    });
  });
});
