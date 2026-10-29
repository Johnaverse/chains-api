import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  getChainDetail: vi.fn(), getEndpointsById: vi.fn(), getRpcMonitoringResults: vi.fn(),
  traverseRelations: vi.fn(), getPriceForChain: vi.fn(), getClientsByChain: vi.fn(),
  getNetworkClients: vi.fn(), getStatusPageByChainId: vi.fn(), getForks: vi.fn(), getTimeline: vi.fn(),
  validateChainData: vi.fn(), ensureChainRpcResults: vi.fn(), getRpcMonitoringStatus: vi.fn()
}));
vi.mock('../../../src/store/queries.js', () => ({ getChainDetail: m.getChainDetail, getEndpointsById: m.getEndpointsById, getRpcMonitoringResults: m.getRpcMonitoringResults }));
vi.mock('../../../src/domain/relations.js', () => ({ traverseRelations: m.traverseRelations }));
vi.mock('../../../priceService.js', () => ({ getPriceForChain: m.getPriceForChain }));
vi.mock('../../../clientsView.js', () => ({ getClientsByChain: m.getClientsByChain, summarizeChainClients: () => ({ clients: [{ name: 'reth' }] }) }));
vi.mock('../../../src/sources/clientFeed.js', () => ({ getNetworkClients: m.getNetworkClients }));
vi.mock('../../../src/sources/statusPages.js', () => ({ getStatusPageByChainId: m.getStatusPageByChainId }));
vi.mock('../../../src/services/forks.js', () => ({ getForks: m.getForks }));
vi.mock('../../../src/services/timeline.js', () => ({ getTimeline: m.getTimeline }));
vi.mock('../../../src/services/validation.js', () => ({ validateChainData: m.validateChainData }));
vi.mock('../../../src/services/chainRefresher.js', () => ({ ensureChainRpcResults: m.ensureChainRpcResults }));
vi.mock('../../../src/services/rpcHealth.js', () => ({ getRpcMonitoringStatus: m.getRpcMonitoringStatus }));
vi.mock('../../../src/store/cache.js', () => ({ getCachedData: () => ({ lastUpdated: null }) }));

const { getChainProfile, _clearChainProfileCache } = await import('../../../src/services/chainProfile.js');

beforeEach(() => {
  vi.clearAllMocks();
  _clearChainProfileCache();
  m.getChainDetail.mockImplementation(id => (id === 1 ? { chainId: 1, name: 'Ethereum Mainnet' } : null));
  m.getEndpointsById.mockReturnValue({ chainId: 1, rpc: ['https://rpc.one'] });
  m.getRpcMonitoringResults.mockReturnValue({ lastUpdated: 't', results: [{ chainId: 1, chainName: 'Ethereum Mainnet', url: 'https://rpc.one', status: 'working' }] });
  m.traverseRelations.mockReturnValue({ nodes: [], edges: [] });
  m.getPriceForChain.mockResolvedValue({ usd: 1 });
  m.getClientsByChain.mockReturnValue({ chainId: 1, clients: [] });
  m.getNetworkClients.mockResolvedValue({ clients: [] });
  m.getStatusPageByChainId.mockReturnValue(null);
  m.getForks.mockResolvedValue({ forks: [{ name: 'Fulu' }] });
  m.getTimeline.mockResolvedValue({ entries: [{ id: 'f', type: 'hardfork' }, { id: 'u', type: 'software_update' }, { id: 'm', type: 'maintenance' }] });
  m.validateChainData.mockReturnValue({ allErrors: [{ rule: 1, chainId: 1 }, { rule: 1, chainId: 2 }], errorsByRule: {} });
  m.getRpcMonitoringStatus.mockReturnValue({ isMonitoring: true });
});

describe('getChainProfile', () => {
  it('assembles every part of the profile in one response', async () => {
    const p = await getChainProfile(1);
    expect(p).toMatchObject({
      chainId: 1,
      chain: { name: 'Ethereum Mainnet', price: { usd: 1 } },
      endpoints: { rpc: ['https://rpc.one'] },
      rpcMonitor: { totalEndpoints: 1, workingEndpoints: 1, clients: [{ name: 'reth' }] },
      forks: { forks: [{ name: 'Fulu' }] },

      validation: { chainId: 1, totalErrors: 1 }
    });
    expect(p.unavailable).toBeUndefined();
    // One timeline read; hardforks are their own part.
    expect(m.getTimeline).toHaveBeenCalledTimes(1);
    expect(p.events.entries.map(e => e.type)).toEqual(['software_update', 'maintenance']);
    // The profile shows what is known: it never waits on an on-demand probe.
    expect(m.ensureChainRpcResults).not.toHaveBeenCalled();
  });

  it('reports a failing source as unavailable instead of failing the profile', async () => {
    m.getForks.mockRejectedValue(new Error('feeds down'));
    m.traverseRelations.mockImplementation(() => { throw new Error('bad relation'); });
    m.validateChainData.mockReturnValue({ error: 'Data not loaded' });
    const p = await getChainProfile(1);
    expect(p.forks).toBeNull();
    expect(p.relations).toBeNull();
    expect(p.validation).toBeNull();
    expect(p.unavailable).toEqual({ forks: 'feeds down', relations: 'bad relation', validation: 'Data not loaded' });
    expect(p.chain.name).toBe('Ethereum Mainnet');
  });

  it('does not wait on a slow source', async () => {
    vi.useFakeTimers();
    try {
      m.getNetworkClients.mockReturnValue(new Promise(() => {}));
      const pending = getChainProfile(1);
      await vi.advanceTimersByTimeAsync(8000);
      const p = await pending;
      expect(p.unavailable).toEqual({ networkClients: 'timed out' });
    } finally { vi.useRealTimers(); }
  });

  it('answers null for a chain no registry lists, and reuses a fresh profile', async () => {
    expect(await getChainProfile(999)).toBeNull();
    await getChainProfile(1, 0);
    await getChainProfile(1, 10000);
    expect(m.getForks).toHaveBeenCalledTimes(1);
    await getChainProfile(1, 40000);
    expect(m.getForks).toHaveBeenCalledTimes(2);
  });
});
