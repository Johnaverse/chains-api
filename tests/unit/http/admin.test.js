import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/store/cache.js', () => ({
  getCachedData: vi.fn()
}));

vi.mock('../../../src/store/queries.js', () => ({
  getAllChains: vi.fn(() => []),
  getRpcMonitoringResults: vi.fn(() => ({
    lastUpdated: null,
    totalEndpoints: 0,
    testedEndpoints: 0,
    workingEndpoints: 0,
    failedEndpoints: 0,
    results: []
  })),
  countChainsByTag: vi.fn(() => ({ totalChains: 0, totalMainnets: 0, totalTestnets: 0, totalL2s: 0, totalBeacons: 0, byStatus: {}, activeChains: 0, deprecatedChains: 0 }))
}));

vi.mock('../../../src/domain/keywords.js', () => ({
  getAllKeywords: vi.fn(() => ({ totalKeywords: 0, keywords: {} }))
}));

vi.mock('../../../src/services/loader.js', () => ({
  loadData: vi.fn()
}));

vi.mock('../../../src/services/rpcHealth.js', () => ({
  startRpcHealthCheck: vi.fn(),
  getRpcMonitoringStatus: vi.fn(() => ({ isMonitoring: false, lastUpdated: null }))
}));

vi.mock('../../../src/services/validation.js', () => ({
  validateChainData: vi.fn(() => ({ totalErrors: 0, errorsByRule: {}, summary: {}, allErrors: [] }))
}));

vi.mock('../../../src/services/l2beatRefresher.js', () => ({
  getL2BeatRefreshStatus: vi.fn(() => ({
    isRefreshing: false,
    lastRefreshAt: null,
    lastRefreshSource: null,
    lastRefreshError: null,
    lastRefreshProjectCount: 0,
    intervalMs: 300000
  }))
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  RELOAD_RATE_LIMIT_MAX: 5,
  RATE_LIMIT_WINDOW_MS: 60000,
  DATA_CACHE_ENABLED: false,
  DATA_CACHE_FILE: '.cache/test-data.json',
  L2BEAT_STALE_AFTER_MS: 6 * 60 * 60 * 1000
}));

import Fastify from 'fastify';
import { getCachedData } from '../../../src/store/cache.js';
import { getRpcMonitoringStatus } from '../../../src/services/rpcHealth.js';
import { getL2BeatRefreshStatus } from '../../../src/services/l2beatRefresher.js';
import { adminRoutes } from '../../../src/http/routes/admin.js';

// Local alias to keep the test bodies readable.
const dataService = { getCachedData, getRpcMonitoringStatus };

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(adminRoutes);
  return app;
}

describe('GET /health (deepened)', () => {
  let app;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('returns status=ok and per-source freshness when all core sources loaded', async () => {
    const now = new Date().toISOString();
    dataService.getCachedData.mockReturnValue({
      theGraph: { networks: [] },
      chainlist: [],
      chains: [],
      slip44: { 60: {} },
      l2beat: { source: 'live', fetchedAt: now, projects: [{ slug: 'arbitrum', chainId: 42161 }] },
      indexed: { all: [{ chainId: 1 }] },
      lastUpdated: now
    });
    dataService.getRpcMonitoringStatus.mockReturnValue({ isMonitoring: false, lastUpdated: now });
    getL2BeatRefreshStatus.mockReturnValue({
      isRefreshing: false,
      lastRefreshAt: now,
      lastRefreshSource: 'live',
      lastRefreshError: null,
      lastRefreshProjectCount: 1,
      intervalMs: 300000
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.sources.theGraph.loaded).toBe(true);
    expect(body.sources.l2beat.loaded).toBe(true);
    expect(body.sources.l2beat.source).toBe('live');
    expect(typeof body.sources.theGraph.ageSeconds).toBe('number');
    expect(body.refreshers.l2beat.lastRefreshAt).toBe(now);
  });

  it('returns status=down when a core source is missing', async () => {
    dataService.getCachedData.mockReturnValue({
      theGraph: null,
      chainlist: [],
      chains: [],
      slip44: {},
      l2beat: null,
      indexed: null,
      lastUpdated: null
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().status).toBe('down');
  });

  it('stays status=ok when L2BEAT is on its static fallback (graceful, not degraded)', async () => {
    const now = new Date().toISOString();
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: { 60: {} },
      l2beat: { source: 'fallback', fetchedAt: now, projects: [{ slug: 'arbitrum', chainId: 42161 }] },
      indexed: { all: [{ chainId: 1 }] },
      lastUpdated: now
    });
    dataService.getRpcMonitoringStatus.mockReturnValue({ isMonitoring: false, lastUpdated: now });
    getL2BeatRefreshStatus.mockReturnValue({
      isRefreshing: false,
      lastRefreshAt: now,
      lastRefreshSource: 'fallback',
      lastRefreshError: null,
      lastRefreshProjectCount: 1,
      intervalMs: 300000
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.sources.l2beat.source).toBe('fallback');
  });

  it('returns status=degraded only when L2BEAT has not refreshed for a very long time', async () => {
    const now = new Date().toISOString();
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: { 60: {} },
      l2beat: { source: 'live', fetchedAt: sevenHoursAgo, projects: [{ chainId: 1 }] },
      indexed: { all: [{ chainId: 1 }] },
      lastUpdated: now
    });
    dataService.getRpcMonitoringStatus.mockReturnValue({ isMonitoring: false, lastUpdated: now });
    getL2BeatRefreshStatus.mockReturnValue({
      isRefreshing: false,
      lastRefreshAt: sevenHoursAgo,   // > L2BEAT_STALE_AFTER_MS (6h) → genuinely stuck
      lastRefreshSource: 'live',
      lastRefreshError: null,
      lastRefreshProjectCount: 1,
      intervalMs: 300000
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json().status).toBe('degraded');
  });

  it('returns status=degraded when slip44 fetch failed (null) but core sources loaded', async () => {
    const now = new Date().toISOString();
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: null,        // fetch failed
      l2beat: { source: 'live', fetchedAt: now, projects: [{ chainId: 1 }] },
      indexed: { all: [] },
      lastUpdated: now
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.sources.slip44.loaded).toBe(false);
  });

  it('marks l2beat as not loaded when fallback returned no projects', async () => {
    const now = new Date().toISOString();
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: { 60: {} },
      l2beat: { source: 'unavailable', fetchedAt: null, projects: [] },
      indexed: { all: [] },
      lastUpdated: now
    });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.sources.l2beat.loaded).toBe(false);
    expect(body.sources.l2beat.source).toBe('unavailable');
  });
});

describe('GET /sources (extended with l2beat + slip44 null awareness)', () => {
  let app;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('reports slip44: not loaded when slip44 is null (fetch failed)', async () => {
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: null,
      l2beat: { projects: [] },
      indexed: { all: [] },
      lastUpdated: null
    });

    const res = await app.inject({ method: 'GET', url: '/sources' });
    expect(res.json().sources.slip44).toBe('not loaded');
  });

  it('reports l2beat: loaded when projects array is non-empty', async () => {
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: {},
      l2beat: { projects: [{ chainId: 1 }] },
      indexed: { all: [] },
      lastUpdated: null
    });

    const res = await app.inject({ method: 'GET', url: '/sources' });
    expect(res.json().sources.l2beat).toBe('loaded');
  });

  it('reports slip44: not loaded when fetched but parsed zero rows ({})', async () => {
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: {}, // fetched OK but parser produced nothing (e.g. upstream drift)
      l2beat: { projects: [{ chainId: 1 }] },
      indexed: { all: [] },
      lastUpdated: null
    });

    const res = await app.inject({ method: 'GET', url: '/sources' });
    expect(res.json().sources.slip44).toBe('not loaded');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json().sources.slip44.loaded).toBe(false);
    expect(health.json().status).toBe('degraded'); // supplementary source missing
  });
});
