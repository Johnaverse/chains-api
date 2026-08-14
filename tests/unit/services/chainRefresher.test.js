import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/sources/l2beat.js', () => ({
  fetchL2Beat: vi.fn()
}));

vi.mock('../../../rpcUtil.js', () => ({
  jsonRpcCall: vi.fn()
}));

// Mock only the persistence side-effect; keep the real rpcStateChanged so the
// change-detection behaviour is exercised end to end.
vi.mock('../../../src/store/rpcHealthStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, persistChainRpcHealth: vi.fn(() => Promise.resolve()) };
});

vi.mock('../../../config.js', () => ({
  RPC_CHECK_TIMEOUT_MS: 5000,
  RPC_CHECK_CONCURRENCY: 8,
  MAX_ENDPOINTS_PER_CHAIN: 5,
  L2BEAT_REFRESH_INTERVAL_MS: 60000,
  DATA_SOURCE_L2BEAT_API: 'https://l2beat.test/api/scaling-summary',
  L2BEAT_FETCH_TIMEOUT_MS: 1000,
  PROXY_URL: '',
  PROXY_ENABLED: false,
  // chainRefresher now persists the sweep via snapshot.js, which reads these.
  DATA_CACHE_ENABLED: false,
  DATA_CACHE_FILE: '.cache/test-refresher-cache.json'
}));

import { fetchL2Beat } from '../../../src/sources/l2beat.js';
import { jsonRpcCall } from '../../../rpcUtil.js';
import { persistChainRpcHealth } from '../../../src/store/rpcHealthStore.js';
import { applyDataToCache, cachedData } from '../../../src/store/cache.js';
import {
  processChainRpc,
  processL2BeatBatch,
  tickOnce,
  getChainRefresherStatus,
  ensureChainRpcResults,
  _resetChainRefresherForTests
} from '../../../src/services/chainRefresher.js';

function seedChain(chainId, rpc = []) {
  const chain = {
    chainId,
    name: `Chain ${chainId}`,
    tags: [],
    relations: [],
    sources: ['chainlist'],
    rpc
  };
  return chain;
}

function seedCacheWith(chains) {
  const byChainId = {};
  for (const c of chains) byChainId[c.chainId] = c;
  applyDataToCache({
    indexed: { byChainId, byName: {}, all: chains },
    lastUpdated: '2026-05-05T00:00:00.000Z'
  });
}

describe('chainRefresher', () => {
  beforeEach(() => {
    _resetChainRefresherForTests();
    applyDataToCache({});
    fetchL2Beat.mockReset();
    jsonRpcCall.mockReset();
  });

  afterEach(() => {
    _resetChainRefresherForTests();
  });

  describe('processChainRpc', () => {
    it('is a no-op when chain is not in the index', async () => {
      seedCacheWith([seedChain(1)]);
      await processChainRpc(999);
      expect(cachedData.rpcHealth?.[999]).toBeUndefined();
    });

    it('never probes an RPC URL that is not publicly routable', async () => {
      // Registry URLs are community-submitted, and this sweep runs unattended. A crafted entry
      // pointing at a cluster address would otherwise have the refresher reach inside the
      // network on our behalf on every pass. Only the public endpoint may be dialled.
      seedCacheWith([seedChain(1, [
        'http://10.43.0.1:8545',
        'http://127.0.0.1:8545',
        'http://169.254.169.254/latest/meta-data',
        'http://chains-api:3000',
        'http://db.svc.cluster.local:5432',
        'https://rpc-public.example'
      ])]);
      jsonRpcCall.mockResolvedValueOnce('Geth/v1.0').mockResolvedValueOnce('0x10');

      await processChainRpc(1);

      expect(cachedData.rpcHealth[1]).toHaveLength(1);
      expect(cachedData.rpcHealth[1][0].url).toBe('https://rpc-public.example');
      // Two calls: clientVersion + blockNumber, for the one endpoint that survived.
      expect(jsonRpcCall).toHaveBeenCalledTimes(2);
      for (const [url] of jsonRpcCall.mock.calls) expect(url).toBe('https://rpc-public.example');
    });

    it('writes per-endpoint results and stamps chain.lastTested', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example', 'https://rpc-b.example'])]);
      jsonRpcCall
        .mockResolvedValueOnce('Geth/v1.0')  // rpc-a clientVersion
        .mockResolvedValueOnce('0x10')       // rpc-a blockNumber
        .mockResolvedValueOnce('Erigon/v1.0') // rpc-b clientVersion
        .mockResolvedValueOnce('0x12');      // rpc-b blockNumber

      await processChainRpc(1);

      expect(cachedData.rpcHealth[1]).toHaveLength(2);
      expect(cachedData.rpcHealth[1][0].ok).toBe(true);
      expect(cachedData.indexed.byChainId[1].lastTested).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // lastRpcCheck (the /clients + /rpc-monitor freshness signal) is stamped
      // per chain as results are written, not only at sweep completion.
      expect(cachedData.lastRpcCheck).toBe(cachedData.indexed.byChainId[1].lastTested);
    });

  describe('ensureChainRpcResults (on-demand probe)', () => {
    it('returns true without probing when results already exist', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      cachedData.rpcHealth = { 1: [{ url: 'https://rpc-a.example', ok: true }] };
      expect(await ensureChainRpcResults(1)).toBe(true);
      expect(jsonRpcCall).not.toHaveBeenCalled();
    });

    it('probes endpoints on demand when the sweep has not reached the chain', async () => {
      seedCacheWith([seedChain(8453, ['https://mainnet.base.example'])]);
      jsonRpcCall.mockResolvedValueOnce('Geth/v1.0').mockResolvedValueOnce('0x10');

      expect(await ensureChainRpcResults(8453)).toBe(true);
      expect(cachedData.rpcHealth[8453]).toHaveLength(1);
      expect(cachedData.rpcHealth[8453][0].ok).toBe(true);
    });

    it('returns false for an unknown chain without probing', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      expect(await ensureChainRpcResults(999999)).toBe(false);
      expect(jsonRpcCall).not.toHaveBeenCalled();
    });

    it('returns false for a chain with no publicly checkable endpoints', async () => {
      seedCacheWith([seedChain(2, ['wss://ws.example', 'https://x.example/${API_KEY}'])]);
      expect(await ensureChainRpcResults(2)).toBe(false);
      expect(jsonRpcCall).not.toHaveBeenCalled();
    });

    it('dedupes concurrent probes for the same chain', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      const resolvers = [];
      jsonRpcCall.mockImplementation(() => new Promise(r => { resolvers.push(r); }));

      const first = ensureChainRpcResults(1);
      const second = ensureChainRpcResults(1);
      await new Promise(r => setImmediate(r));
      for (const r of resolvers) r('Geth/v1.0');
      // Both in-flight calls resolve from the SAME probe: one endpoint means
      // exactly two jsonRpcCall invocations (clientVersion + blockNumber).
      await Promise.all([first, second]);
      expect(jsonRpcCall).toHaveBeenCalledTimes(2);
    });
  });

    it('does not stamp lastRpcCheck when the data-version race guard trips', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      cachedData.lastRpcCheck = null;
      jsonRpcCall.mockImplementation(async () => {
        cachedData.lastUpdated = '2026-05-05T02:00:00.000Z';
        return 'whatever';
      });

      await processChainRpc(1);

      expect(cachedData.lastRpcCheck).toBeNull();
    });

    it('respects the data-version race guard', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);

      // Have jsonRpcCall mutate cachedData.lastUpdated mid-flight, simulating
      // a concurrent loadData() during the RPC sweep.
      jsonRpcCall.mockImplementation(async () => {
        cachedData.lastUpdated = '2026-05-05T01:00:00.000Z';
        return 'whatever';
      });

      await processChainRpc(1);

      // The race guard should have skipped writing rpcHealth.
      expect(cachedData.rpcHealth?.[1]).toBeUndefined();
    });

    it('skips chains with no http endpoints', async () => {
      seedCacheWith([seedChain(1, ['wss://only-websocket.example'])]);
      await processChainRpc(1);
      expect(cachedData.rpcHealth?.[1]).toBeUndefined();
      expect(jsonRpcCall).not.toHaveBeenCalled();
    });

    it('excludes key-templated endpoints entirely (not tested, not reported)', async () => {
      seedCacheWith([seedChain(1, [
        'https://mainnet.infura.io/v3/${INFURA_API_KEY}',
        'https://rpc.ankr.com/eth/${ANKR_API_KEY}',
        'https://ethereum-rpc.publicnode.com'
      ])]);
      jsonRpcCall
        .mockResolvedValueOnce('Geth/v1.0') // publicnode clientVersion
        .mockResolvedValueOnce('0x10');     // publicnode blockNumber

      await processChainRpc(1);

      // Only the real public endpoint is tested and stored; the ${...} ones
      // never appear in the results.
      expect(cachedData.rpcHealth[1]).toHaveLength(1);
      expect(cachedData.rpcHealth[1][0].url).toBe('https://ethereum-rpc.publicnode.com');
      const testedUrls = cachedData.rpcHealth[1].map(r => r.url);
      expect(testedUrls.some(u => u.includes('${'))).toBe(false);
    });
  });

  describe('processL2BeatBatch', () => {
    it('skips when no data is loaded', async () => {
      const result = await processL2BeatBatch();
      expect(result).toEqual({ skipped: 'no-data' });
    });

    it('writes cachedData.l2beat and updates status on success', async () => {
      seedCacheWith([seedChain(42161)]);
      fetchL2Beat.mockResolvedValueOnce({
        source: 'live',
        fetchedAt: '2026-05-05T12:00:00.000Z',
        projects: [{ slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One' }]
      });

      const result = await processL2BeatBatch();

      expect(result.source).toBe('live');
      expect(result.projectCount).toBe(1);
      expect(cachedData.l2beat?.source).toBe('live');
      expect(getChainRefresherStatus().l2beat.lastRefreshSource).toBe('live');
    });
  });

  describe('tickOnce / queue scheduling', () => {
    it('first tick processes l2beat_batch (head of fresh queue)', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      fetchL2Beat.mockResolvedValueOnce({
        source: 'live', fetchedAt: '2026-05-05T00:00:00.000Z',
        projects: [{ slug: 'eth', chainId: 1, displayName: 'Ethereum' }]
      });

      await tickOnce();

      const status = getChainRefresherStatus();
      expect(status.lastTickJobType).toBe('l2beat_batch');
      expect(status.sweep.jobIndex).toBe(1);
      expect(fetchL2Beat).toHaveBeenCalledTimes(1);
    });

    it('subsequent ticks process chain_rpc jobs in order', async () => {
      seedCacheWith([
        seedChain(1, ['https://rpc-a.example']),
        seedChain(2, ['https://rpc-b.example'])
      ]);
      fetchL2Beat.mockResolvedValueOnce({
        source: 'live', fetchedAt: '2026-05-05T00:00:00.000Z', projects: []
      });
      jsonRpcCall
        .mockResolvedValueOnce('Geth/v1')
        .mockResolvedValueOnce('0x10')
        .mockResolvedValueOnce('Erigon/v1')
        .mockResolvedValueOnce('0x12');

      await tickOnce(); // l2beat_batch
      await tickOnce(); // chain_rpc 1
      await tickOnce(); // chain_rpc 2

      expect(cachedData.rpcHealth[1]).toHaveLength(1);
      expect(cachedData.rpcHealth[2]).toHaveLength(1);

      const status = getChainRefresherStatus();
      expect(status.queueDepth).toBe(0);
      expect(status.sweep.totalJobs).toBe(3); // 1 l2beat + 2 chains
    });

    it('rebuilds the queue once it drains, incrementing sweep number', async () => {
      seedCacheWith([seedChain(1, [])]);  // no RPCs to keep test deterministic
      fetchL2Beat.mockResolvedValue({
        source: 'live', fetchedAt: '2026-05-05T00:00:00.000Z', projects: []
      });

      await tickOnce(); // l2beat_batch (sweep #1)
      await tickOnce(); // chain_rpc 1 (no-op, but increments cursor)
      // queue empty -> next tick rebuilds
      await tickOnce(); // l2beat_batch again (sweep #2)

      expect(getChainRefresherStatus().sweep.sweepNumber).toBe(2);
    });

    it('persists a chain incrementally when its endpoint state changes', async () => {
      persistChainRpcHealth.mockClear();
      seedCacheWith([seedChain(1, ['http://rpc.one'])]);
      // healthy endpoint: clientVersion + block height
      jsonRpcCall.mockImplementation((_url, method) =>
        Promise.resolve(method === 'web3_clientVersion' ? 'geth/v1' : '0x10'));

      await processChainRpc(1); // no prior state -> changed -> persist

      expect(persistChainRpcHealth).toHaveBeenCalledTimes(1);
      expect(persistChainRpcHealth).toHaveBeenCalledWith(1, expect.arrayContaining([
        expect.objectContaining({ url: 'http://rpc.one', ok: true })
      ]));
    });

    it('does not persist when only the block height advances (no state change)', async () => {
      seedCacheWith([seedChain(1, ['http://rpc.one'])]);
      // Prior cached state: same URL, already up.
      cachedData.rpcHealth = { 1: [{ url: 'http://rpc.one', ok: true, blockHeight: 16 }] };
      persistChainRpcHealth.mockClear();
      jsonRpcCall.mockImplementation((_url, method) =>
        Promise.resolve(method === 'web3_clientVersion' ? 'geth/v1' : '0x20')); // new block

      await processChainRpc(1);

      expect(persistChainRpcHealth).not.toHaveBeenCalled();
    });

    it('overlap guard: a tick in flight is skipped, not queued behind itself', async () => {
      seedCacheWith([seedChain(1, [])]);
      let release;
      fetchL2Beat.mockImplementation(() => new Promise(r => { release = r; }));

      const first = tickOnce();    // sets tickInFlight = true
      await tickOnce();            // immediately returns (no-op while in flight)
      release({ source: 'live', fetchedAt: 'x', projects: [] });
      await first;

      // Only one fetchL2Beat call: the second tick saw tickInFlight and bailed.
      expect(fetchL2Beat).toHaveBeenCalledTimes(1);
    });
  });

  describe('getChainRefresherStatus', () => {
    it('exposes tick + sweep + per-job-type state', async () => {
      seedCacheWith([seedChain(1, [])]);
      fetchL2Beat.mockResolvedValue({
        source: 'fallback', fetchedAt: null, projects: []
      });

      await tickOnce();
      const status = getChainRefresherStatus();

      expect(status.tickIntervalMs).toBeGreaterThan(0);
      expect(status.lastTickAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(status.l2beat.lastRefreshSource).toBe('fallback');
      expect(status.rpc).toHaveProperty('isMonitoring');
      expect(status.sweep).toHaveProperty('sweepNumber');
    });
  });
});
