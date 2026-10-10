import { describe, it, expect, vi, afterEach } from 'vitest';

// A snapshot written by an older build was indexed without the research dataset, and
// the stale-first boot serves it as-is while the registries refresh in the background.
// The research must be re-stamped on the loaded index, or ?family= and the corrected
// websites stay empty until that refresh lands (or forever, if every registry is down).
vi.mock('../../../src/store/snapshot.js', () => ({
  readSnapshotFromDisk: vi.fn(),
  writeSnapshotToDiskAtomic: vi.fn(),
  DATA_CACHE_PATH: '/tmp/snapshot.json'
}));
vi.mock('../../../src/store/rpcHealthStore.js', () => ({ loadAllRpcHealthFromDisk: vi.fn(async () => ({ byChainId: {}, lastCheckedAt: null })) }));
vi.mock('../../../src/transport/fetch.js', () => ({ fetchData: vi.fn(async () => { throw new Error('registry down'); }) }));
vi.mock('../../../src/sources/l2beat.js', () => ({ fetchL2Beat: vi.fn(async () => null) }));
vi.mock('../../../src/sources/defillama.js', () => ({ fetchDefiLlama: vi.fn(async () => null) }));

const { readSnapshotFromDisk } = await import('../../../src/store/snapshot.js');
const { cachedData } = await import('../../../src/store/cache.js');
const { initializeDataOnStartup } = await import('../../../src/services/loader.js');
const { getAllChains, filterChainsByFamily, getChainById } = await import('../../../src/store/queries.js');

describe('initializeDataOnStartup — stale snapshot', () => {
  afterEach(() => { cachedData.indexed = null; });

  it('re-stamps the research dataset on a snapshot indexed without it', async () => {
    const base = { chainId: 8453, name: 'Base', infoURL: 'https://base.org', sources: ['chains'] };
    const thai = { chainId: 7, name: 'ThaiChain', infoURL: 'https://thaichain.io', sources: ['chains'] };
    // A real snapshot is JSON on disk, so `all` and `byChainId` come back as separate copies.
    readSnapshotFromDisk.mockResolvedValue(JSON.parse(JSON.stringify({
      theGraph: { networks: [] }, chainlist: [], chains: [], slip44: { 60: {} }, l2beat: null, defillama: null,
      indexed: { byChainId: { 8453: base, 7: thai }, byName: {}, all: [base, thai] },
      lastUpdated: '2026-10-01T00:00:00.000Z'
    })));

    await initializeDataOnStartup();

    expect(getChainById(8453)).toMatchObject({ family: 'OP Stack-derived', sources: ['chains', 'research'] });
    expect(getChainById(7)).toMatchObject({ infoURL: 'https://thaichain.org/', infoURLSource: 'research' });
    // The list projections read indexed.all, not byChainId.
    expect(filterChainsByFamily(getAllChains(), 'op stack').map(c => c.chainId)).toEqual([8453]);
    expect(getAllChains().find(c => c.chainId === 7).infoURL).toBe('https://thaichain.org/');
    expect(cachedData.indexed.all).toContain(cachedData.indexed.byChainId[8453]);
  });
});
