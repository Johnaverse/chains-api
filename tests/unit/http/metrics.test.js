import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/store/cache.js', () => ({
  getCachedData: vi.fn()
}));

vi.mock('../../../src/services/rpcHealth.js', () => ({
  getRpcMonitoringStatus: vi.fn(() => ({ isMonitoring: false, lastUpdated: null }))
}));

vi.mock('../../../src/services/validation.js', () => ({
  validateChainData: vi.fn(() => ({
    totalErrors: 0,
    summary: { rule1: 0, rule12: 3, rule13: 1 },
    errorsByRule: {},
    allErrors: []
  }))
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

import Fastify from 'fastify';
import { getCachedData } from '../../../src/store/cache.js';
import { metricsRoute } from '../../../src/http/routes/metrics.js';
import { incCounter, _resetMetricsForTests } from '../../../src/util/metrics.js';

// Local alias to keep test body using `dataService.getCachedData.mockReturnValue(...)`.
const dataService = { getCachedData };

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(metricsRoute);
  return app;
}

describe('GET /metrics (Prometheus exposition)', () => {
  let app;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetMetricsForTests();
    app = await buildApp();
  });

  it('returns text/plain content type', async () => {
    dataService.getCachedData.mockReturnValue({ indexed: { all: [] } });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });

  it('reports process memory against the heap limit', async () => {
    dataService.getCachedData.mockReturnValue({ indexed: { all: [] } });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    for (const name of ['chains_api_process_resident_bytes', 'chains_api_heap_used_bytes', 'chains_api_heap_limit_bytes', 'chains_api_client_feed_cache_bytes', 'chains_api_client_feed_cache_entries']) {
      expect(res.body).toMatch(new RegExp(`^${name} \\d+$`, 'm'));
    }
  });

  it('renders chains_api_chains_total gauge', async () => {
    dataService.getCachedData.mockReturnValue({
      indexed: { all: new Array(123).fill({}) }
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('chains_api_chains_total 123');
  });

  it('renders source-loaded gauges for all 5 sources', async () => {
    dataService.getCachedData.mockReturnValue({
      theGraph: {},
      chainlist: [],
      chains: [],
      slip44: {},
      l2beat: { projects: [{ chainId: 1 }] },
      indexed: { all: [] }
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/chains_api_source_loaded\{source="theGraph"\} 1/);
    expect(res.body).toMatch(/chains_api_source_loaded\{source="l2beat"\} 1/);
  });

  it('renders 0 for sources that failed to load', async () => {
    dataService.getCachedData.mockReturnValue({
      theGraph: null,
      chainlist: null,
      chains: null,
      slip44: null,
      l2beat: null,
      indexed: { all: [] }
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/chains_api_source_loaded\{source="theGraph"\} 0/);
    expect(res.body).toMatch(/chains_api_source_loaded\{source="l2beat"\} 0/);
  });

  it('renders incremented counters with labels', async () => {
    dataService.getCachedData.mockReturnValue({ indexed: { all: [] } });
    incCounter('chains_api_refresh_total', { refresher: 'l2beat', outcome: 'live' }, 3);
    incCounter('chains_api_refresh_total', { refresher: 'l2beat', outcome: 'fallback' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/chains_api_refresh_total\{outcome="live",refresher="l2beat"\} 3/);
    expect(res.body).toMatch(/chains_api_refresh_total\{outcome="fallback",refresher="l2beat"\} 1/);
  });

  it('renders validation error counts per rule from the summary', async () => {
    dataService.getCachedData.mockReturnValue({ indexed: { all: [] } });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/chains_api_validation_errors\{rule="rule12"\} 3/);
    expect(res.body).toMatch(/chains_api_validation_errors\{rule="rule13"\} 1/);
  });
});
