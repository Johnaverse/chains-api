import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/sources/l2beat.js', () => ({
  fetchL2Beat: vi.fn()
}));

vi.mock('../../../rpcUtil.js', async (importOriginal) => ({
  ...(await importOriginal()),
  jsonRpcCall: vi.fn()
}));

// Mock only the persistence side-effect; keep the real rpcStateChanged so the
// change-detection behaviour is exercised end to end.
vi.mock('../../../src/store/rpcHealthStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, persistChainRpcHealth: vi.fn(() => Promise.resolve()) };
});

vi.mock('../../../src/sources/nodeForkSchedule.js', () => ({
  refreshNodeForkSchedule: vi.fn(() => Promise.resolve(null))
}));

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
import { refreshNodeForkSchedule } from '../../../src/sources/nodeForkSchedule.js';
import { persistChainRpcHealth } from '../../../src/store/rpcHealthStore.js';
import { applyDataToCache, cachedData } from '../../../src/store/cache.js';
import { isPrivateRpc, _resetPrivateRpcsForTests } from '../../../src/store/privateRpcStore.js';
import {
  processChainRpc,
  processL2BeatBatch,
  tickOnce,
  getChainRefresherStatus,
  ensureChainRpcResults,
  _resetChainRefresherForTests,
  providerOf
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
    _resetPrivateRpcsForTests();
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

    it('does not count an endpoint that serves another chain as this chain\'s', async () => {
      // Tempo's deprecated Andantino (42429) lists Moderato's RPC, which answers as 42431.
      seedCacheWith([seedChain(42429, ['https://rpc-moderato.example', 'https://rpc-silent-id.example'])]);
      jsonRpcCall.mockImplementation(async (url, method) => {
        if (method === 'web3_clientVersion') return 'tempo/v1';
        if (method === 'eth_blockNumber') return '0x10';
        if (url === 'https://rpc-silent-id.example') throw new Error('method not found');
        return '0xa5bf'; // 42431
      });
      await processChainRpc(42429);
      const [moderato, silent] = cachedData.rpcHealth[42429];
      expect(moderato).toMatchObject({ ok: false, failure: 'wrong_chain', servedChainId: 42431 });
      // One that will not say which chain it serves is judged on its blocks.
      expect(silent).toMatchObject({ ok: true, blockHeight: 16 });
    });

    it('backs a provider off when it rate-limits the chain-id question, keeping the block verdict', async () => {
      seedCacheWith([seedChain(1, ['https://a.limited.example']), seedChain(10, ['https://b.limited.example'])]);
      jsonRpcCall.mockImplementation(async (_url, method) => {
        if (method === 'eth_chainId') throw Object.assign(new Error('HTTP 429'), { kind: 'rate_limited', status: 429 });
        return method === 'web3_clientVersion' ? 'Geth/v1' : '0x10';
      });
      await processChainRpc(1);
      expect(cachedData.rpcHealth[1][0]).toMatchObject({ ok: true, blockHeight: 16 });
      jsonRpcCall.mockClear();
      await processChainRpc(10);
      // Same provider (limited.example): deferred, not probed.
      expect(jsonRpcCall).not.toHaveBeenCalled();
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
      // Three calls — clientVersion, blockNumber, and the chain id it serves — for the one
      // endpoint that survived.
      expect(jsonRpcCall).toHaveBeenCalledTimes(3);
      for (const [url] of jsonRpcCall.mock.calls) expect(url).toBe('https://rpc-public.example');
    });

    it('never probes a public-looking RPC name whose DNS answers a private address', async () => {
      const { lookup } = await import('node:dns/promises');
      lookup.mockResolvedValueOnce([{ address: '10.43.0.1', family: 4 }]);
      seedCacheWith([seedChain(1, ['https://rpc.points-inside.example'])]);

      await processChainRpc(1);

      expect(jsonRpcCall).not.toHaveBeenCalled();
      expect(cachedData.rpcHealth[1][0]).toMatchObject({ ok: false, failure: 'private_address' });
    });

    it('drops an endpoint that answers HTTP 401 and never probes it again', async () => {
      // A 401 is a keyed/private endpoint: listing it as a public RPC is wrong, and probing it
      // on every sweep is wasted fan-out.
      seedCacheWith([seedChain(1, ['https://rpc-public.example', { url: 'https://rpc-keyed.example' }])]);
      const unauthorized = Object.assign(new Error('HTTP 401'), { status: 401 });
      jsonRpcCall.mockImplementation(async (url, method) => {
        if (url === 'https://rpc-keyed.example') throw unauthorized;
        return method === 'eth_chainId' ? '0x1' : method === 'web3_clientVersion' ? 'Geth/v1.0' : '0x10';
      });

      await processChainRpc(1);

      expect(isPrivateRpc('https://rpc-keyed.example')).toBe(true);
      expect(cachedData.indexed.byChainId[1].rpc).toEqual(['https://rpc-public.example']);
      expect(cachedData.rpcHealth[1].map(r => r.url)).toEqual(['https://rpc-public.example']);

      jsonRpcCall.mockClear();
      await processChainRpc(1);
      for (const [url] of jsonRpcCall.mock.calls) expect(url).toBe('https://rpc-public.example');

      // A source re-fetch rebuilds rpc from the registries; the private URL stays dropped.
      seedCacheWith([seedChain(1, ['https://rpc-public.example', 'https://rpc-keyed.example'])]);
      expect(cachedData.indexed.byChainId[1].rpc).toEqual(['https://rpc-public.example']);
    });

    it('applies a 401 to every chain listing the same URL', async () => {
      seedCacheWith([
        seedChain(1, ['https://rpc-keyed.example', 'https://rpc-a.example']),
        seedChain(2, ['https://rpc-keyed.example'])
      ]);
      cachedData.rpcHealth = { 2: [{ url: 'https://rpc-keyed.example', ok: false }] };
      jsonRpcCall.mockImplementation(async (url, method) => {
        if (url === 'https://rpc-keyed.example') throw Object.assign(new Error('HTTP 401'), { status: 401 });
        return method === 'eth_chainId' ? '0x1' : method === 'web3_clientVersion' ? 'Geth/v1.0' : '0x10';
      });

      await processChainRpc(1);

      // Chain 2 now has no probe-able URL, so it would never clean itself up.
      expect(cachedData.indexed.byChainId[2].rpc).toEqual([]);
      expect(cachedData.rpcHealth[2]).toEqual([]);
    });

    it('records a 401 even when a data refresh lands mid-probe', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-keyed.example'])]);
      jsonRpcCall.mockImplementation(async () => {
        // The refresh swaps in a rebuilt index that still lists the URL.
        applyDataToCache({
          indexed: { byChainId: { 1: seedChain(1, ['https://rpc-keyed.example']) }, byName: {}, all: [] },
          lastUpdated: '2026-05-06T00:00:00.000Z'
        });
        throw Object.assign(new Error('HTTP 401'), { status: 401 });
      });

      await processChainRpc(1);

      expect(isPrivateRpc('https://rpc-keyed.example')).toBe(true);
      // Later probes skip the URL, so the replacement cache must be cleaned now or never.
      expect(cachedData.indexed.byChainId[1].rpc).toEqual([]);
    });

    it('drops an endpoint that answers HTTP 403', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-forbidden.example'])]);
      jsonRpcCall.mockRejectedValue(Object.assign(new Error('HTTP 403'), { status: 403 }));

      await processChainRpc(1);

      expect(isPrivateRpc('https://rpc-forbidden.example')).toBe(true);
      expect(cachedData.indexed.byChainId[1].rpc).toEqual([]);
      expect(cachedData.rpcHealth[1]).toEqual([]);
    });

    it.each([429, 500, 503])('keeps an endpoint that fails with HTTP %i', async (status) => {
      // Rate limits and outages are transient — not proof the endpoint is private.
      seedCacheWith([seedChain(1, ['https://rpc-flaky.example'])]);
      jsonRpcCall.mockRejectedValue(Object.assign(new Error(`HTTP ${status}`), { status }));

      await processChainRpc(1);

      expect(isPrivateRpc('https://rpc-flaky.example')).toBe(false);
      expect(cachedData.rpcHealth[1]).toHaveLength(1);
      expect(cachedData.rpcHealth[1][0].ok).toBe(false);
      expect(cachedData.indexed.byChainId[1].rpc).toEqual(['https://rpc-flaky.example']);
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

    it('records a node that gave its client version but no block as answered, not gone', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      jsonRpcCall.mockImplementation(async (_url, method) => {
        if (method === 'web3_clientVersion') return 'Geth/v1.0';
        throw Object.assign(new Error('RPC request timed out'), { kind: 'timeout' });
      });

      await processChainRpc(1);

      expect(cachedData.rpcHealth[1][0]).toMatchObject({ ok: false, failure: 'answered_no_block' });
    });

    it('keeps since when an endpoint answers nothing across silent checks, and restarts it on any answer', async () => {
      seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
      const silent = () => jsonRpcCall.mockRejectedValue(Object.assign(new Error('fetch failed'), { kind: 'unreachable' }));
      silent();
      await processChainRpc(1);
      expect(cachedData.rpcHealth[1][0].unansweredSince).toMatch(/^\d{4}-/);

      cachedData.rpcHealth[1][0].unansweredSince = '2026-01-01T00:00:00.000Z';
      await processChainRpc(1);
      expect(cachedData.rpcHealth[1][0].unansweredSince).toBe('2026-01-01T00:00:00.000Z');

      // A rate limit is an answer: the endpoint is there.
      jsonRpcCall.mockRejectedValue(Object.assign(new Error('HTTP 429'), { kind: 'rate_limited', status: 429 }));
      await processChainRpc(1);
      expect(cachedData.rpcHealth[1][0].unansweredSince).toBeUndefined();

      // The provider is backed off now; once that passes, the endpoint is probed again.
      vi.useFakeTimers({ now: Date.now() + 61 * 60 * 1000, toFake: ['Date'] });
      silent();
      await processChainRpc(1);
      vi.useRealTimers();
      expect(Date.parse(cachedData.rpcHealth[1][0].unansweredSince)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
    });

  it('reads the node fork schedule only from endpoints that served blocks in this pass', async () => {
    seedCacheWith([seedChain(1, ['https://rpc-a.example'])]);
    jsonRpcCall.mockResolvedValueOnce('Geth/v1.0').mockResolvedValueOnce('0x10');
    await processChainRpc(1);
    expect(refreshNodeForkSchedule).toHaveBeenLastCalledWith(1, ['https://rpc-a.example']);

    // The provider rate-limits us: backed off, its endpoint keeps its earlier healthy result,
    // and is not sent eth_config either.
    jsonRpcCall.mockRejectedValue(Object.assign(new Error('HTTP 429'), { kind: 'rate_limited', status: 429 }));
    await processChainRpc(1);
    cachedData.rpcHealth[1] = [{ url: 'https://rpc-a.example', ok: true, blockHeight: 16 }];
    await processChainRpc(1);
    expect(cachedData.rpcHealth[1][0].ok).toBe(true);
    expect(refreshNodeForkSchedule).toHaveBeenLastCalledWith(1, []);
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

    it('backs off a provider that limits us, keeping each endpoint\'s last result meanwhile', async () => {
      seedCacheWith([
        seedChain(1, ['https://c1.rpc.provider.example']),
        seedChain(10, ['https://c10.rpc.provider.example', 'https://rpc.other.example'])
      ]);
      cachedData.rpcHealth = { 10: [{ url: 'https://c10.rpc.provider.example', ok: true, blockHeight: 5 }] };
      jsonRpcCall.mockRejectedValue(Object.assign(new Error('try again later'), { kind: 'rate_limited' }));
      await processChainRpc(1);
      expect(cachedData.rpcHealth[1][0]).toMatchObject({ ok: false, failure: 'rate_limited' });

      // Chain 10's endpoint on the same provider is not probed; the other provider is.
      jsonRpcCall.mockReset();
      jsonRpcCall.mockImplementation(async (_url, method) => (method === 'eth_chainId' ? '0xa' : '0x20'));
      await processChainRpc(10);
      expect(jsonRpcCall.mock.calls.map(([url]) => url)).toEqual(['https://rpc.other.example', 'https://rpc.other.example', 'https://rpc.other.example']);
      expect(cachedData.rpcHealth[10]).toEqual([
        { url: 'https://c10.rpc.provider.example', ok: true, blockHeight: 5 },
        expect.objectContaining({ url: 'https://rpc.other.example', ok: true })
      ]);
      expect(providerOf('https://c10.rpc.provider.example/path')).toBe('provider.example');
      expect(providerOf('https://rpc.example.co.uk')).toBe('example.co.uk');
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

    it('carries on with the sweep when the data reloads mid-sweep, skipping chains it lost', async () => {
      seedCacheWith([
        seedChain(1, ['https://rpc-a.example']),
        seedChain(2, ['https://rpc-b.example']),
        seedChain(3, ['https://rpc-c.example'])
      ]);
      fetchL2Beat.mockResolvedValue({ source: 'live', fetchedAt: '2026-05-05T00:00:00.000Z', projects: [] });
      jsonRpcCall.mockImplementation(async (_url, method) => (method === 'eth_chainId' ? '0x1' : method === 'web3_clientVersion' ? 'Geth/v1' : '0x10'));

      await tickOnce(); // l2beat_batch
      await tickOnce(); // chain_rpc 1
      // A scheduled reload lands: chain 2 is gone upstream, chain 3 stays.
      delete cachedData.indexed.byChainId[2];
      cachedData.lastUpdated = '2026-05-05T06:00:00.000Z';
      await tickOnce(); // chain_rpc 3

      expect(Object.keys(cachedData.rpcHealth).sort()).toEqual(['1', '3']);
      expect(getChainRefresherStatus().sweep.sweepNumber).toBe(1);
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
        Promise.resolve(method === 'eth_chainId' ? '0x1' : method === 'web3_clientVersion' ? 'geth/v1' : '0x10'));

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
        Promise.resolve(method === 'eth_chainId' ? '0x1' : method === 'web3_clientVersion' ? 'geth/v1' : '0x20')); // new block

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
