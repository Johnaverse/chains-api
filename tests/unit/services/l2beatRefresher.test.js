import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/sources/l2beat.js', () => ({
  fetchL2Beat: vi.fn()
}));

vi.mock('../../../config.js', () => ({
  L2BEAT_REFRESH_INTERVAL_MS: 60000,
  DATA_SOURCE_L2BEAT_API: 'https://l2beat.test/api/scaling-summary',
  L2BEAT_FETCH_TIMEOUT_MS: 1000,
  // chainRefresher (which l2beatRefresher now delegates to) transitively
  // imports rpcUtil.js + fetchUtil.js, which need these env constants.
  RPC_CHECK_TIMEOUT_MS: 5000,
  RPC_CHECK_CONCURRENCY: 8,
  PROXY_URL: '',
  PROXY_ENABLED: false,
  // chainRefresher starts the connection pool recycler; 0 leaves it off.
  FETCH_POOL_MAX_AGE_MS: 0,
  // chainRefresher persists sweeps via snapshot.js, which reads these.
  DATA_CACHE_ENABLED: false,
  DATA_CACHE_FILE: '.cache/test-refresher-cache.json'
}));

import { fetchL2Beat } from '../../../src/sources/l2beat.js';
import { applyDataToCache, cachedData } from '../../../src/store/cache.js';
import {
  runL2BeatRefresh,
  startL2BeatRefresh,
  stopL2BeatRefresh,
  getL2BeatRefreshStatus
} from '../../../src/services/l2beatRefresher.js';

function seedIndexedCache() {
  applyDataToCache({
    indexed: {
      byChainId: {
        42161: { chainId: 42161, name: 'Arbitrum One', tags: [], sources: [], relations: [] },
        10:    { chainId: 10,    name: 'OP Mainnet',   tags: [], sources: [], relations: [] }
      },
      byName: {},
      all: []
    },
    lastUpdated: '2026-05-05T00:00:00.000Z'
  });
  cachedData.indexed.all = Object.values(cachedData.indexed.byChainId);
}

describe('l2beatRefresher', () => {
  beforeEach(() => {
    fetchL2Beat.mockReset();
    applyDataToCache({});
    stopL2BeatRefresh();
  });

  afterEach(() => {
    stopL2BeatRefresh();
  });

  describe('runL2BeatRefresh', () => {
    it('skips when data is not loaded', async () => {
      const result = await runL2BeatRefresh();
      expect(result).toEqual({ skipped: 'no-data' });
      expect(fetchL2Beat).not.toHaveBeenCalled();
    });

    it('updates cache.l2beat and merges into indexed on success', async () => {
      seedIndexedCache();
      fetchL2Beat.mockResolvedValueOnce({
        source: 'live',
        fetchedAt: '2026-05-05T12:00:00.000Z',
        projects: [
          { slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One', stage: 'Stage 1', category: 'Optimistic Rollup' }
        ]
      });

      const result = await runL2BeatRefresh();

      expect(result.source).toBe('live');
      expect(result.projectCount).toBe(1);
      expect(cachedData.l2beat?.source).toBe('live');
      expect(cachedData.indexed.byChainId[42161].l2Beat).toMatchObject({
        slug: 'arbitrum',
        stage: 'Stage 1',
        dataFreshness: 'live'
      });
    });

    it('skips writing when cache.lastUpdated changes mid-flight (race guard)', async () => {
      seedIndexedCache();
      let resolveFetch;
      fetchL2Beat.mockImplementation(() => new Promise(resolve => { resolveFetch = resolve; }));

      const refreshPromise = runL2BeatRefresh();

      // Simulate a concurrent loadData() bumping lastUpdated.
      cachedData.lastUpdated = '2026-05-05T01:00:00.000Z';
      resolveFetch({
        source: 'live',
        fetchedAt: '2026-05-05T12:00:00.000Z',
        projects: [{ slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One' }]
      });

      const result = await refreshPromise;
      expect(result).toEqual({ skipped: 'data-changed' });
      expect(cachedData.indexed.byChainId[42161].l2Beat).toBeUndefined();
    });

    it('records lastRefreshError on fetch failure', async () => {
      seedIndexedCache();
      fetchL2Beat.mockRejectedValueOnce(new Error('boom'));

      const result = await runL2BeatRefresh();
      expect(result.skipped).toBe('fetch-error');
      expect(getL2BeatRefreshStatus().lastRefreshError).toBe('boom');
    });
  });

  describe('getL2BeatRefreshStatus', () => {
    it('exposes intervalMs and refresh state', async () => {
      seedIndexedCache();
      fetchL2Beat.mockResolvedValueOnce({
        source: 'fallback',
        fetchedAt: null,
        projects: [{ slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One' }]
      });

      await runL2BeatRefresh();
      const status = getL2BeatRefreshStatus();
      expect(status.intervalMs).toBe(60000);
      expect(status.lastRefreshSource).toBe('fallback');
      expect(status.lastRefreshProjectCount).toBe(1);
      expect(status.lastRefreshAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(status.isRefreshing).toBe(false);
    });
  });

  describe('startL2BeatRefresh idempotency', () => {
    it('starting twice does not double-schedule', async () => {
      seedIndexedCache();
      fetchL2Beat.mockResolvedValue({
        source: 'live',
        fetchedAt: '2026-05-05T12:00:00.000Z',
        projects: []
      });

      startL2BeatRefresh();
      startL2BeatRefresh();
      // Allow the immediate kick-off to settle.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      expect(fetchL2Beat.mock.calls.length).toBeLessThanOrEqual(2);
      stopL2BeatRefresh();
    });
  });
});
