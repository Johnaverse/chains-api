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
  m.getTimeline.mockImplementation(async ({ type }) => ({ entries: [{ id: type, type }] }));
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
      events: { entries: [{ type: 'software_update' }, { type: 'maintenance' }] },
      validation: { chainId: 1, totalErrors: 1 }
    });
    expect(p.unavailable).toBeUndefined();
    // Hardforks are their own part: events asks for the other two types.
    expect(m.getTimeline.mock.calls.map(c => c[0].type)).toEqual(['software_update', 'maintenance']);
  });

  it('reports a failing source as unavailable instead of failing the profile', async () => {
    m.getForks.mockRejectedValue(new Error('feeds down'));
    const p = await getChainProfile(1);
    expect(p.forks).toBeNull();
    expect(p.unavailable).toEqual({ forks: 'feeds down' });
    expect(p.chain.name).toBe('Ethereum Mainnet');
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
