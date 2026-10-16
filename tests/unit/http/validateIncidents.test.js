import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';

// The handler's decisions are the subject here, not the rules — those are covered by
// tests/unit/services/incidentSentinel.test.js. So the sentinel is mocked and each test asks
// only: did the route take the right branch, and did it reach upstream when it must not?

vi.mock('../../../src/services/incidentSentinel.js', () => ({
  inspectCachedIncidents: vi.fn(),
  runIncidentSentinel: vi.fn()
}));

vi.mock('../../../src/store/cache.js', () => ({ getCachedData: vi.fn(() => ({})) }));
vi.mock('../../../src/services/loader.js', () => ({ loadData: vi.fn() }));
vi.mock('../../../src/services/rpcHealth.js', () => ({
  startRpcHealthCheck: vi.fn(),
  getRpcMonitoringStatus: vi.fn(() => ({ isMonitoring: false, lastUpdated: null }))
}));

const CACHED = { fetchedAt: '2026-09-27T09:00:00.000Z', totalEvents: 3, totalFindings: 1, summary: {}, rules: {} };
const FRESH = { fetchedAt: '2026-09-27T10:00:00.000Z', totalEvents: 4, totalFindings: 0, summary: {}, rules: {} };

/**
 * DIAGNOSTICS_TOKEN is a module-level binding read at import time, so varying it means
 * rebuilding the module graph — and `vi.resetModules()` alone is not enough, because it leaves
 * the mock registry intact and a hoisted config mock would keep its first value. `vi.doMock`
 * registers a fresh factory per build.
 *
 * The AJV options mirror src/http/app.js. Fastify's DEFAULT is `removeAdditional: true`, which
 * silently strips an unknown query key instead of rejecting it — so a bare Fastify here would
 * pass `?refrsh=true` through to the cached path while production answers 400, and the schema
 * tests would be asserting behaviour production does not have.
 */
async function build(token) {
  vi.resetModules();
  vi.resetAllMocks();
  vi.doMock('../../../config.js', async (importOriginal) => ({
    ...(await importOriginal()),
    RELOAD_RATE_LIMIT_MAX: 5,
    RATE_LIMIT_WINDOW_MS: 60000,
    DATA_CACHE_ENABLED: false,
    DATA_CACHE_FILE: '.cache/test-data.json',
    L2BEAT_STALE_AFTER_MS: 6 * 60 * 60 * 1000,
    DIAGNOSTICS_TOKEN: token
  }));
  const { adminRoutes } = await import('../../../src/http/routes/admin.js');
  const sentinel = await import('../../../src/services/incidentSentinel.js');
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: 'array', allErrors: true } }
  });
  await app.register(adminRoutes);
  return { app, sentinel };
}

describe('GET /validate/incidents', () => {
  describe('cached report — the open, non-amplifying path', () => {
    it('serves the report over the cache without refreshing', async () => {
      const { app, sentinel } = await build('');
      sentinel.inspectCachedIncidents.mockReturnValue(CACHED);

      const res = await app.inject({ method: 'GET', url: '/validate/incidents' });
      expect(res.statusCode).toBe(200);
      expect(res.json().fetchedAt).toBe(CACHED.fetchedAt);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });

    it('answers 503 when nothing is cached, rather than quietly fetching', async () => {
      // Inventing a fetch to cover an empty cache is exactly the amplification the split
      // exists to prevent, so the route must say so instead.
      const { app, sentinel } = await build('s3cret');
      sentinel.inspectCachedIncidents.mockReturnValue(null);

      const res = await app.inject({ method: 'GET', url: '/validate/incidents' });
      expect(res.statusCode).toBe(503);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });

    it('treats an explicit refresh=false as the cached path', async () => {
      const { app, sentinel } = await build('s3cret');
      sentinel.inspectCachedIncidents.mockReturnValue(CACHED);

      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=false' });
      expect(res.statusCode).toBe(200);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });
  });

  describe('?refresh=true — the amplifying path (contract §10)', () => {
    it('is closed by default: 404 when no token is configured', async () => {
      const { app, sentinel } = await build('');
      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=true' });
      expect(res.statusCode).toBe(404);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });

    it('stays 404 when unconfigured even if a caller sends a token', async () => {
      // An unset token must never be satisfiable — least of all by guessing one.
      const { app, sentinel } = await build('');
      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=true&token=anything' });
      expect(res.statusCode).toBe(404);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });

    it('rejects a missing token with 401 once one is configured', async () => {
      const { app, sentinel } = await build('s3cret');
      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=true' });
      expect(res.statusCode).toBe(401);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });

    it('rejects a wrong token with 401, including one of a different length', async () => {
      const { app, sentinel } = await build('s3cret');
      for (const token of ['wrong!', 'x', 's3cret-and-then-some']) {
        const res = await app.inject({ method: 'GET', url: `/validate/incidents?refresh=true&token=${token}` });
        expect(res.statusCode).toBe(401);
      }
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
    });

    it('refreshes with the right token in the query string', async () => {
      const { app, sentinel } = await build('s3cret');
      sentinel.runIncidentSentinel.mockResolvedValue(FRESH);

      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=true&token=s3cret' });
      expect(res.statusCode).toBe(200);
      expect(res.json().fetchedAt).toBe(FRESH.fetchedAt);
      expect(sentinel.runIncidentSentinel).toHaveBeenCalledTimes(1);
      expect(sentinel.inspectCachedIncidents).not.toHaveBeenCalled();
    });

    it('refreshes with the right token in the x-diagnostics-token header', async () => {
      const { app, sentinel } = await build('s3cret');
      sentinel.runIncidentSentinel.mockResolvedValue(FRESH);

      const res = await app.inject({
        method: 'GET',
        url: '/validate/incidents?refresh=true',
        headers: { 'x-diagnostics-token': 's3cret' }
      });
      expect(res.statusCode).toBe(200);
      expect(sentinel.runIncidentSentinel).toHaveBeenCalledTimes(1);
    });

    it('answers 503 when an authorized refresh cannot reach the feed', async () => {
      const { app, sentinel } = await build('s3cret');
      sentinel.runIncidentSentinel.mockRejectedValue(new Error('feed down'));

      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=true&token=s3cret' });
      expect(res.statusCode).toBe(503);
    });
  });

  describe('schema', () => {
    it('rejects an unknown query parameter with 400', async () => {
      // A typo like ?refrsh=true must not silently fall through to the cached path.
      const { app, sentinel } = await build('s3cret');
      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refrsh=true' });
      expect(res.statusCode).toBe(400);
      expect(sentinel.runIncidentSentinel).not.toHaveBeenCalled();
      expect(sentinel.inspectCachedIncidents).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean refresh value with 400', async () => {
      const { app } = await build('s3cret');
      const res = await app.inject({ method: 'GET', url: '/validate/incidents?refresh=maybe' });
      expect(res.statusCode).toBe(400);
    });
  });
});
