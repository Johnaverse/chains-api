import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dataService before importing
vi.mock('../../dataService.js', () => ({
  getCachedData: vi.fn(() => ({
    theGraph: { networks: [] },
    chainlist: [],
    chains: [],
    slip44: {
      0: { coinType: 0, symbol: 'BTC', coin: 'Bitcoin' },
      60: { coinType: 60, symbol: 'ETH', coin: 'Ethereum' },
    },
    indexed: { all: [] },
    lastUpdated: '2024-01-01T00:00:00.000Z',
  })),
  searchChains: vi.fn(() => []),
  getChainById: vi.fn(() => null),
  getAllChains: vi.fn(() => []),
  getAllRelations: vi.fn(() => []),
  getRelationsById: vi.fn(() => null),
  getEndpointsById: vi.fn(() => null),
  getAllEndpoints: vi.fn(() => []),
  getAllKeywords: vi.fn(() => ({
    totalKeywords: 0,
    keywords: {
      blockchainNames: [],
      networkNames: [],
      softwareClients: [],
      currencySymbols: [],
      tags: [],
      relationKinds: [],
      sources: [],
      statuses: [],
      generic: [],
    },
  })),
  validateChainData: vi.fn(() => ({ totalErrors: 0, errorsByRule: {}, summary: {}, allErrors: [] })),
  traverseRelations: vi.fn(() => null),
  countChainsByTag: vi.fn((chains) => {
    let totalTestnets = 0;
    let totalL2s = 0;
    let totalBeacons = 0;
    let totalMainnets = 0;
    for (const chain of chains) {
      const tags = chain.tags || [];
      const isTestnet = tags.includes('Testnet');
      const isL2 = tags.includes('L2');
      const isBeacon = tags.includes('Beacon');
      if (isTestnet) totalTestnets += 1;
      if (isL2) totalL2s += 1;
      if (isBeacon) totalBeacons += 1;
      if (!isTestnet && !isL2 && !isBeacon) totalMainnets += 1;
    }
    const byStatus = {};
    for (const chain of chains) {
      const status = chain.status || 'unknown';
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
    const deprecatedChains = byStatus.deprecated || 0;
    return {
      totalChains: chains.length, totalMainnets, totalTestnets, totalL2s, totalBeacons,
      byStatus, activeChains: chains.length - deprecatedChains, deprecatedChains
    };
  }),
  getRpcMonitoringResults: vi.fn(() => ({
    lastUpdated: '2024-01-01T00:00:00.000Z',
    totalEndpoints: 0,
    testedEndpoints: 0,
    workingEndpoints: 0,
    failedEndpoints: 0,
    results: [],
  })),
  getRpcMonitoringStatus: vi.fn(() => ({
    isMonitoring: false,
    lastUpdated: null,
  })),
}));

vi.mock('../../src/services/l2beatRefresher.js', () => ({
  getL2BeatRefreshStatus: vi.fn(() => ({
    isRefreshing: false,
    lastRefreshAt: '2026-05-05T12:00:00.000Z',
    lastRefreshSource: 'live',
    lastRefreshError: null,
    lastRefreshProjectCount: 28,
    intervalMs: 300000,
  })),
}));

vi.mock('../../clientsView.js', () => ({
  getClientsByChain: vi.fn(() => null),
  summarizeChainClients: vi.fn(() => null),
}));

vi.mock('../../src/sources/statusPages.js', () => ({
  getAllStatusPages: vi.fn(() => [
    { id: 'base', name: 'Base', url: 'https://base-l2.statuspage.io/', chainIds: [8453, 84532] },
  ]),
  getAllCoinStatusPages: vi.fn(() => [
    { symbol: 'SOL', name: 'Solana', url: 'https://status.solana.com/' },
  ]),
  getStatusPageByChainId: vi.fn((chainId) =>
    chainId === 8453
      ? { chainId: 8453, statusPage: 'https://base-l2.statuspage.io/', project: { id: 'base', name: 'Base' } }
      : null
  ),
  getStatusPageBySymbol: vi.fn((symbol) =>
    typeof symbol === 'string' && symbol.toUpperCase() === 'SOL'
      ? { symbol: 'SOL', statusPage: 'https://status.solana.com/', name: 'Solana' }
      : null
  ),
}));

vi.mock('../../src/sources/liveIncidents.js', () => ({
  getLiveIncidents: vi.fn(async () => ({
    fetchedAt: '2026-07-06T00:00:00.000Z',
    count: 1,
    totalMatched: 1,
    incidents: [
      {
        title: 'RPC degraded',
        url: 'https://status.example/1',
        publishedAt: '2026-07-05T10:00:00.000Z',
        publishedMs: 1783072800000,
        statusPage: { id: 'base', name: 'Base', kind: 'chain' },
        isProvider: false,
        chains: [{ chainId: 8453, name: 'Base' }],
        affectedComponents: [],
      },
    ],
  })),
}));

vi.mock('../../src/sources/forumNews.js', () => ({
  getForumNews: vi.fn(async () => ({
    fetchedAt: '2026-07-06T00:00:00.000Z',
    count: 1,
    totalMatched: 1,
    news: [
      {
        title: 'Hash-chain RANDAO',
        url: 'https://ethereum-magicians.org/t/hash-chain-randao/28942',
        publishedAt: '2026-07-05T22:50:49.481Z',
        publishedMs: 1783118449481,
        summary: null,
        tags: ['postquantum'],
        forum: { id: 'ethereum', name: 'Ethereum Magicians', url: 'https://ethereum-magicians.org' },
        chains: [{ chainId: 1, name: 'Ethereum Mainnet' }],
      },
    ],
  })),
}));

vi.mock('../../priceService.js', () => ({
  getPricesForChains: vi.fn(async (chainIds) => {
    const map = new Map();
    for (const id of chainIds) map.set(id, null);
    return map;
  }),
  getPriceForChain: vi.fn(async () => null),
  getCoinGeckoId: vi.fn(() => null),
  clearPriceCache: vi.fn(),
}));

import * as dataService from '../../dataService.js';
import * as clientsView from '../../clientsView.js';
import * as priceService from '../../priceService.js';
import * as liveIncidents from '../../src/sources/liveIncidents.js';
import * as forumNews from '../../src/sources/forumNews.js';
import { getToolDefinitions, handleToolCall } from '../../mcp-tools.js';

describe('MCP Tools - Shared Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dataService.getCachedData).mockReturnValue({
      theGraph: { networks: [] },
      chainlist: [],
      chains: [],
      slip44: {
        0: { coinType: 0, symbol: 'BTC', coin: 'Bitcoin' },
        60: { coinType: 60, symbol: 'ETH', coin: 'Ethereum' },
      },
      indexed: { all: [] },
      lastUpdated: '2024-01-01T00:00:00.000Z',
    });
    vi.mocked(dataService.searchChains).mockReturnValue([]);
    vi.mocked(dataService.getChainById).mockReturnValue(null);
    vi.mocked(dataService.getAllChains).mockReturnValue([]);
    vi.mocked(dataService.getAllRelations).mockReturnValue([]);
    vi.mocked(dataService.getRelationsById).mockReturnValue(null);
    vi.mocked(dataService.getEndpointsById).mockReturnValue(null);
    vi.mocked(dataService.getAllEndpoints).mockReturnValue([]);
    vi.mocked(dataService.getAllKeywords).mockReturnValue({
      totalKeywords: 0,
      keywords: {
        blockchainNames: [],
        networkNames: [],
        softwareClients: [],
        currencySymbols: [],
        tags: [],
        relationKinds: [],
        sources: [],
        statuses: [],
        generic: [],
      },
    });
    vi.mocked(dataService.validateChainData).mockReturnValue({
      totalErrors: 0, errorsByRule: {}, summary: {}, allErrors: [],
    });
    vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
      lastUpdated: '2024-01-01T00:00:00.000Z',
      totalEndpoints: 0,
      testedEndpoints: 0,
      workingEndpoints: 0,
      results: [],
    });
    vi.mocked(dataService.getRpcMonitoringStatus).mockReturnValue({
      isMonitoring: false,
      lastUpdated: null,
    });
  });

  describe('getToolDefinitions', () => {
    it('should return an array of 22 tools', () => {
      const tools = getToolDefinitions();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(22);
    });

    it('should include all expected tool names', () => {
      const tools = getToolDefinitions();
      const names = tools.map(t => t.name);
      expect(names).toContain('get_chains');
      expect(names).toContain('get_chain_by_id');
      expect(names).toContain('search_chains');
      expect(names).toContain('get_endpoints');
      expect(names).toContain('get_relations');
      expect(names).toContain('get_slip44');
      expect(names).toContain('get_sources');
      expect(names).toContain('get_keywords');
      expect(names).toContain('validate_chains');
      expect(names).toContain('get_stats');
      expect(names).toContain('traverse_relations');
      expect(names).toContain('get_rpc_monitor');
      expect(names).toContain('get_rpc_monitor_by_id');
      expect(names).toContain('get_clients');
      expect(names).toContain('get_live_incidents');
      expect(names).toContain('get_forum_news');
    });

    it('should require chainId for traverse_relations', () => {
      const tools = getToolDefinitions();
      const tool = tools.find(t => t.name === 'traverse_relations');
      expect(tool.inputSchema.required).toContain('chainId');
    });

    it('should have proper schema structure for each tool', () => {
      const tools = getToolDefinitions();
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema).toHaveProperty('properties');
      }
    });

    it('should require chainId for get_chain_by_id', () => {
      const tools = getToolDefinitions();
      const tool = tools.find(t => t.name === 'get_chain_by_id');
      expect(tool.inputSchema.required).toContain('chainId');
    });

    it('should require query for search_chains', () => {
      const tools = getToolDefinitions();
      const tool = tools.find(t => t.name === 'search_chains');
      expect(tool.inputSchema.required).toContain('query');
    });

    it('should require chainId for get_rpc_monitor_by_id', () => {
      const tools = getToolDefinitions();
      const tool = tools.find(t => t.name === 'get_rpc_monitor_by_id');
      expect(tool.inputSchema.required).toContain('chainId');
    });
  });

  describe('handleToolCall - get_chains', () => {
    it('should return all chains without filter', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
        { chainId: 137, name: 'Polygon', tags: ['L2'] },
      ]);

      const result = await handleToolCall('get_chains', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.totalMatched).toBe(2);
      expect(data.truncated).toBe(false);
      expect(data.chains.length).toBe(2);
      expect(result.isError).toBeUndefined();
    });

    it('caps the returned list but reports the full total via totalMatched', async () => {
      const many = Array.from({ length: 130 }, (_, i) => ({ chainId: i + 1, name: `Chain ${i + 1}`, tags: [] }));
      vi.mocked(dataService.getAllChains).mockReturnValue(many);

      const result = await handleToolCall('get_chains', { limit: 20 });
      const data = JSON.parse(result.content[0].text);
      expect(data.totalMatched).toBe(130);
      expect(data.count).toBe(20);
      expect(data.chains.length).toBe(20);
      expect(data.truncated).toBe(true);
    });

    it('applies the default cap (50) when no limit is given', async () => {
      const many = Array.from({ length: 130 }, (_, i) => ({ chainId: i + 1, name: `Chain ${i + 1}`, tags: [] }));
      vi.mocked(dataService.getAllChains).mockReturnValue(many);

      const result = await handleToolCall('get_chains', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(50);
      expect(data.totalMatched).toBe(130);
    });

    it('filters by lifecycle status', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [], status: 'active' },
        { chainId: 5, name: 'Goerli', tags: ['Testnet'], status: 'deprecated' },
        { chainId: 11155111, name: 'Sepolia', tags: ['Testnet'], status: 'active' },
      ]);

      const result = await handleToolCall('get_chains', { status: 'deprecated' });
      const data = JSON.parse(result.content[0].text);
      expect(data.totalMatched).toBe(1);
      expect(data.chains.map((c) => c.chainId)).toEqual([5]);
    });

    it('should filter chains by tag', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
        { chainId: 137, name: 'Polygon', tags: ['L2'] },
        { chainId: 10, name: 'Optimism', tags: ['L2'] },
      ]);

      const result = await handleToolCall('get_chains', { tag: 'L2' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.chains.every(c => c.tags.includes('L2'))).toBe(true);
    });

    it('should return empty array when no chains match tag', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
      ]);

      const result = await handleToolCall('get_chains', { tag: 'Beacon' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.chains).toEqual([]);
    });

    it('should include price field on each chain', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
      ]);
      vi.mocked(priceService.getPricesForChains).mockResolvedValue(
        new Map([[1, { usd: 2000.5, updatedAt: '2026-05-01T00:00:00.000Z' }]])
      );
      const result = await handleToolCall('get_chains', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.chains[0]).toHaveProperty('price');
      expect(data.chains[0].price).toEqual({ usd: 2000.5, updatedAt: '2026-05-01T00:00:00.000Z' });
    });

    it('should set price: null for unknown chains', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 99999, name: 'Unknown Chain', tags: [] },
      ]);
      vi.mocked(priceService.getPricesForChains).mockResolvedValue(
        new Map([[99999, null]])
      );
      const result = await handleToolCall('get_chains', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.chains[0].price).toBeNull();
    });
  });

  describe('handleToolCall - get_chain_by_id', () => {
    it('should return chain by valid ID', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue({
        chainId: 1, name: 'Ethereum', nativeCurrency: { symbol: 'ETH' },
      });

      const result = await handleToolCall('get_chain_by_id', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
      expect(data.name).toBe('Ethereum');
    });

    it('should return error for invalid chain ID type', async () => {
      const result = await handleToolCall('get_chain_by_id', { chainId: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error for NaN chain ID', async () => {
      const result = await handleToolCall('get_chain_by_id', { chainId: NaN });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error for non-existent chain', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue(null);
      const result = await handleToolCall('get_chain_by_id', { chainId: 999999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Chain not found');
    });

    it('should include price when CoinGecko returns data', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue({
        chainId: 1, name: 'Ethereum', nativeCurrency: { symbol: 'ETH' },
      });
      vi.mocked(priceService.getPriceForChain).mockResolvedValue({
        usd: 2000.5, updatedAt: '2026-05-01T00:00:00.000Z',
      });
      const result = await handleToolCall('get_chain_by_id', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.price).toEqual({ usd: 2000.5, updatedAt: '2026-05-01T00:00:00.000Z' });
    });

    it('should set price: null when CoinGecko fetch fails', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue({
        chainId: 1, name: 'Ethereum', nativeCurrency: { symbol: 'ETH' },
      });
      vi.mocked(priceService.getPriceForChain).mockResolvedValue(null);
      const result = await handleToolCall('get_chain_by_id', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.price).toBeNull();
    });
  });

  describe('handleToolCall - search_chains', () => {
    it('should return search results', async () => {
      vi.mocked(dataService.searchChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum' },
        { chainId: 5, name: 'Ethereum Goerli' },
      ]);

      const result = await handleToolCall('search_chains', { query: 'ethereum' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.query).toBe('ethereum');
      expect(data.count).toBe(2);
      expect(data.results.length).toBe(2);
    });

    it('should return error when query is missing', async () => {
      const result = await handleToolCall('search_chains', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Query is required');
    });

    it('should return error when query is empty string', async () => {
      const result = await handleToolCall('search_chains', { query: '' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Query is required');
    });
  });

  describe('handleToolCall - get_endpoints', () => {
    it('should return all endpoints when chainId is not provided', async () => {
      vi.mocked(dataService.getAllEndpoints).mockReturnValue([
        { chainId: 1, rpc: ['https://eth.rpc'] },
        { chainId: 137, rpc: ['https://polygon.rpc'] },
      ]);

      const result = await handleToolCall('get_endpoints', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.endpoints.length).toBe(2);
    });

    it('should return endpoints for specific chain', async () => {
      vi.mocked(dataService.getEndpointsById).mockReturnValue({
        chainId: 1, rpc: ['https://eth.rpc'],
      });

      const result = await handleToolCall('get_endpoints', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
    });

    it('should return error for invalid chain ID', async () => {
      const result = await handleToolCall('get_endpoints', { chainId: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error when chain not found', async () => {
      vi.mocked(dataService.getEndpointsById).mockReturnValue(null);
      const result = await handleToolCall('get_endpoints', { chainId: 999999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Chain not found');
    });
  });

  describe('handleToolCall - get_relations', () => {
    it('should return all relations when chainId is not provided', async () => {
      vi.mocked(dataService.getAllRelations).mockReturnValue([
        { chainId: 1, relations: [] },
        { chainId: 5, relations: [{ type: 'testnet', chainId: 1 }] },
      ]);

      const result = await handleToolCall('get_relations', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should return relations for specific chain', async () => {
      vi.mocked(dataService.getRelationsById).mockReturnValue({
        chainId: 1, relations: [{ kind: 'mainnetOf', chainId: 5 }],
      });

      const result = await handleToolCall('get_relations', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
    });

    it('should return error for invalid chain ID', async () => {
      const result = await handleToolCall('get_relations', { chainId: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error when chain not found', async () => {
      vi.mocked(dataService.getRelationsById).mockReturnValue(null);
      const result = await handleToolCall('get_relations', { chainId: 999999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Chain not found');
    });
  });

  describe('handleToolCall - get_slip44', () => {
    it('should return all coin types', async () => {
      const result = await handleToolCall('get_slip44', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.coinTypes['60'].symbol).toBe('ETH');
    });

    it('should return specific coin type', async () => {
      const result = await handleToolCall('get_slip44', { coinType: 60 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.symbol).toBe('ETH');
    });

    it('should return error for invalid coin type', async () => {
      const result = await handleToolCall('get_slip44', { coinType: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid coin type');
    });

    it('should return error for NaN coin type', async () => {
      const result = await handleToolCall('get_slip44', { coinType: NaN });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid coin type');
    });

    it('should return error for non-existent coin type', async () => {
      const result = await handleToolCall('get_slip44', { coinType: 99999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Coin type not found');
    });

    it('should return error when slip44 data not loaded', async () => {
      vi.mocked(dataService.getCachedData).mockReturnValue({
        theGraph: null, chainlist: null, chains: null, slip44: null,
        indexed: null, lastUpdated: null,
      });
      const result = await handleToolCall('get_slip44', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('SLIP-0044 data not loaded');
    });
  });

  describe('handleToolCall - get_sources', () => {
    it('should return source status when all loaded', async () => {
      const result = await handleToolCall('get_sources', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('sources');
      expect(data.sources.theGraph).toBe('loaded');
      expect(data.sources.chainlist).toBe('loaded');
      expect(data.sources.chains).toBe('loaded');
      expect(data.sources.slip44).toBe('loaded');
    });

    it('should show not loaded for missing sources', async () => {
      vi.mocked(dataService.getCachedData).mockReturnValue({
        theGraph: null, chainlist: null, chains: null, slip44: null,
        indexed: null, lastUpdated: null,
      });

      const result = await handleToolCall('get_sources', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.sources.theGraph).toBe('not loaded');
      expect(data.sources.chainlist).toBe('not loaded');
      expect(data.sources.chains).toBe('not loaded');
      expect(data.sources.slip44).toBe('not loaded');
    });
  });

  describe('handleToolCall - get_keywords', () => {
    it('should return extracted keyword data', async () => {
      vi.mocked(dataService.getCachedData).mockReturnValue({
        theGraph: {},
        chainlist: [],
        chains: [],
        slip44: {},
        indexed: { all: [] },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      });
      vi.mocked(dataService.getAllKeywords).mockReturnValue({
        totalKeywords: 3,
        keywords: {
          blockchainNames: ['Ethereum'],
          networkNames: ['mainnet'],
          softwareClients: ['Geth'],
          currencySymbols: [],
          tags: [],
          relationKinds: [],
          sources: [],
          statuses: [],
          generic: [],
        },
      });

      const result = await handleToolCall('get_keywords', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.lastUpdated).toBe('2024-01-01T00:00:00.000Z');
      expect(data.totalKeywords).toBe(3);
      expect(data.keywords.softwareClients).toContain('Geth');
    });
  });

  describe('handleToolCall - validate_chains', () => {
    it('should return validation results on success', async () => {
      vi.mocked(dataService.validateChainData).mockReturnValue({
        totalErrors: 2,
        errorsByRule: { rule1: [{ chainId: 1 }], rule2: [{ chainId: 2 }] },
        summary: { rule1: 1, rule2: 1 },
        allErrors: [{ chainId: 1 }, { chainId: 2 }],
      });

      const result = await handleToolCall('validate_chains', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.totalErrors).toBe(2);
    });

    it('should return error when data not loaded', async () => {
      vi.mocked(dataService.validateChainData).mockReturnValue({
        error: 'Data not loaded. Please reload data sources first.',
        errors: [],
      });

      const result = await handleToolCall('validate_chains', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toContain('Data not loaded');
    });
  });

  describe('handleToolCall - get_rpc_monitor', () => {
    it('should return combined monitoring results and status', async () => {
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: '2024-01-01T00:00:00.000Z',
        totalEndpoints: 100,
        testedEndpoints: 50,
        workingEndpoints: 45,
        results: [
          { chainId: 1, chainName: 'Ethereum', url: 'https://eth.rpc', status: 'working' },
          { chainId: 137, chainName: 'Polygon', url: 'https://polygon.rpc', status: 'working' },
        ],
      });
      vi.mocked(dataService.getRpcMonitoringStatus).mockReturnValue({
        isMonitoring: true,
        lastUpdated: '2024-01-01T00:00:00.000Z',
      });

      const result = await handleToolCall('get_rpc_monitor', {});
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Running');
      expect(text).toContain('100');
      expect(text).toContain('45');
      expect(text).toContain('per-chain endpoint details');
      expect(text).not.toContain('https://eth.rpc');
      expect(text).not.toContain('https://polygon.rpc');
    });
  });

  describe('handleToolCall - get_rpc_monitor_by_id', () => {
    it('should return monitoring results for specific chain', async () => {
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: '2024-01-01T00:00:00.000Z',
        totalEndpoints: 10,
        testedEndpoints: 5,
        workingEndpoints: 3,
        results: [
          { chainId: 1, chainName: 'Ethereum', url: 'https://eth.rpc', status: 'working' },
          { chainId: 1, chainName: 'Ethereum', url: 'https://eth2.rpc', status: 'failed' },
          { chainId: 137, chainName: 'Polygon', url: 'https://polygon.rpc', status: 'working' },
        ],
      });

      const result = await handleToolCall('get_rpc_monitor_by_id', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Ethereum');
      expect(text).toContain('chain 1');
      expect(text).toContain('1 / 2');
      expect(text).toContain('https://eth.rpc');
      expect(text).toContain('https://eth2.rpc');
    });

    it('should return error for invalid chain ID', async () => {
      const result = await handleToolCall('get_rpc_monitor_by_id', { chainId: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error for NaN chain ID', async () => {
      const result = await handleToolCall('get_rpc_monitor_by_id', { chainId: NaN });
      expect(result.isError).toBe(true);
    });

    it('reports UNKNOWN (never "down") when the chain has no results yet', async () => {
      // Mid-sweep state: other chains tested, this one not reached yet — the
      // exact state after a deploy that once made the assistant declare a
      // healthy chain unhealthy.
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: '2024-01-01T00:00:00.000Z', totalEndpoints: 737, testedEndpoints: 737,
        workingEndpoints: 314, results: [{ chainId: 1, chainName: 'Ethereum', url: 'https://eth.rpc', status: 'working' }],
      });
      vi.mocked(dataService.getEndpointsById).mockReturnValue({ chainId: 8453, name: 'Base', rpc: ['https://mainnet.base.org', 'https://developer-access-mainnet.base.org'] });

      const result = await handleToolCall('get_rpc_monitor_by_id', { chainId: 8453 });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('UNKNOWN');
      expect(text).toContain('does NOT mean the endpoints are down');
      expect(text).toContain('2 RPC endpoint(s)');
      expect(text).not.toMatch(/No working RPC endpoints/);
    });

    it('reports UNKNOWN when monitoring has produced no results at all', async () => {
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: null, totalEndpoints: 0, testedEndpoints: 0,
        workingEndpoints: 0, results: [],
      });
      vi.mocked(dataService.getEndpointsById).mockReturnValue(null);

      const result = await handleToolCall('get_rpc_monitor_by_id', { chainId: 999 });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('UNKNOWN');
    });
  });

  describe('handleToolCall - get_stats', () => {
    it('should return aggregate stats', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [], status: 'active' },
        { chainId: 5, name: 'Goerli', tags: ['Testnet'], status: 'deprecated' },
        { chainId: 137, name: 'Polygon', tags: ['L2'], status: 'active' },
        { chainId: 100, name: 'Gnosis Beacon', tags: ['Beacon'], status: 'active' },
      ]);
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: '2024-01-01T00:00:00.000Z',
        totalEndpoints: 100,
        testedEndpoints: 50,
        workingEndpoints: 40,
        failedEndpoints: 10,
        results: [],
      });

      const result = await handleToolCall('get_stats', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.totalChains).toBe(4);
      expect(data.totalTestnets).toBe(1);
      expect(data.totalL2s).toBe(1);
      expect(data.totalBeacons).toBe(1);
      expect(data.totalMainnets).toBe(1);
      expect(data.activeChains).toBe(3);
      expect(data.deprecatedChains).toBe(1);
      expect(data.byStatus).toEqual({ active: 3, deprecated: 1 });
      expect(data.rpc.working).toBe(40);
      expect(data.rpc.failed).toBe(10);
      expect(data.rpc.healthPercent).toBe(80);
    });

    it('should return null healthPercent when no endpoints tested', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([]);
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: null,
        totalEndpoints: 0,
        testedEndpoints: 0,
        workingEndpoints: 0,
        failedEndpoints: 0,
        results: [],
      });

      const result = await handleToolCall('get_stats', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.rpc.healthPercent).toBeNull();
    });
  });

  describe('handleToolCall - traverse_relations', () => {
    it('should return traversal result for valid chain', async () => {
      vi.mocked(dataService.traverseRelations).mockReturnValue({
        startChainId: 1,
        startChainName: 'Ethereum',
        maxDepth: 2,
        totalNodes: 3,
        totalEdges: 2,
        nodes: [
          { chainId: 1, name: 'Ethereum', tags: [], depth: 0 },
          { chainId: 5, name: 'Goerli', tags: ['Testnet'], depth: 1 },
          { chainId: 10, name: 'Optimism', tags: ['L2'], depth: 1 },
        ],
        edges: [
          { from: 1, to: 5, kind: 'mainnetOf', source: 'theGraph' },
          { from: 1, to: 10, kind: 'parentOf', source: 'theGraph' },
        ],
      });

      const result = await handleToolCall('traverse_relations', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.startChainId).toBe(1);
      expect(data.totalNodes).toBe(3);
      expect(data.totalEdges).toBe(2);
      expect(data.nodes.length).toBe(3);
    });

    it('should return error for invalid chain ID', async () => {
      const result = await handleToolCall('traverse_relations', { chainId: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error for NaN chain ID', async () => {
      const result = await handleToolCall('traverse_relations', { chainId: NaN });
      expect(result.isError).toBe(true);
    });

    it('should return error when chain not found', async () => {
      vi.mocked(dataService.traverseRelations).mockReturnValue(null);
      const result = await handleToolCall('traverse_relations', { chainId: 999999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Chain not found');
    });

    it('should use default depth of 2', async () => {
      vi.mocked(dataService.traverseRelations).mockReturnValue({
        startChainId: 1, startChainName: 'Ethereum', maxDepth: 2,
        totalNodes: 1, totalEdges: 0, nodes: [], edges: [],
      });

      await handleToolCall('traverse_relations', { chainId: 1 });
      expect(dataService.traverseRelations).toHaveBeenCalledWith(1, 2);
    });

    it('should accept custom depth', async () => {
      vi.mocked(dataService.traverseRelations).mockReturnValue({
        startChainId: 1, startChainName: 'Ethereum', maxDepth: 4,
        totalNodes: 1, totalEdges: 0, nodes: [], edges: [],
      });

      await handleToolCall('traverse_relations', { chainId: 1, depth: 4 });
      expect(dataService.traverseRelations).toHaveBeenCalledWith(1, 4);
    });

    it('should reject depth below 1', async () => {
      const result = await handleToolCall('traverse_relations', { chainId: 1, depth: 0 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid depth. Must be between 1 and 5');
    });

    it('should reject depth above 5', async () => {
      const result = await handleToolCall('traverse_relations', { chainId: 1, depth: 6 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid depth. Must be between 1 and 5');
    });
  });

  describe('get_clients', () => {
    it('returns aggregated clients across all chains when chainId omitted', async () => {
      vi.mocked(clientsView.getClientsByChain).mockImplementation((chainId) => {
        if (chainId === undefined) {
          return [
            {
              chainId: 1,
              chainName: 'Ethereum',
              totalNodes: 2,
              unknownNodes: 0,
              clients: [{ name: 'geth', repo: 'ethereum/go-ethereum', nodeCount: 2, versions: [], known: true }]
            }
          ];
        }
        return null;
      });

      const result = await handleToolCall('get_clients', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.chains[0].chainId).toBe(1);
    });

    it('returns summary for a specific chain', async () => {
      vi.mocked(clientsView.getClientsByChain).mockReturnValue({
        chainId: 1,
        chainName: 'Ethereum',
        totalNodes: 1,
        unknownNodes: 0,
        clients: [{ name: 'geth', repo: 'ethereum/go-ethereum', nodeCount: 1, versions: [], known: true }]
      });

      const result = await handleToolCall('get_clients', { chainId: 1 });
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
      expect(data.clients[0].name).toBe('geth');
    });

    it('returns error for invalid chain ID', async () => {
      const result = await handleToolCall('get_clients', { chainId: 'not-a-number' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('returns error when no client data exists for chain', async () => {
      vi.mocked(clientsView.getClientsByChain).mockReturnValue(null);

      const result = await handleToolCall('get_clients', { chainId: 99999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('No client data found for this chain');
    });
  });

  describe('handleToolCall - error handling', () => {
    it('should return error for unknown tool', async () => {
      const result = await handleToolCall('unknown_tool', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Unknown tool: unknown_tool');
    });

    it('should handle internal errors gracefully', async () => {
      vi.mocked(dataService.getAllChains).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await handleToolCall('get_chains', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Internal error');
      expect(data.message).toBe('Database error');
    });
  });

  describe('handleToolCall - get_scaling_chains', () => {
    it('returns chains with l2Beat data plus refresher status block', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
        {
          chainId: 42161,
          name: 'Arbitrum One',
          tags: ['L2'],
          l2Beat: { slug: 'arbitrum', stage: 'Stage 1', category: 'Optimistic Rollup' },
        },
        {
          chainId: 10,
          name: 'OP Mainnet',
          tags: ['L2'],
          l2Beat: { slug: 'optimism', stage: 'Stage 1', category: 'Optimistic Rollup' },
        },
      ]);

      const result = await handleToolCall('get_scaling_chains', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.chains.map((c) => c.chainId)).toEqual([42161, 10]);
      expect(data.refresher.lastRefreshSource).toBe('live');
    });

    it('returns count=0 when no chains have l2Beat data', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
      ]);
      const result = await handleToolCall('get_scaling_chains', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.chains).toEqual([]);
    });
  });

  describe('handleToolCall - get_l2beat_by_id', () => {
    it('returns the chain when L2BEAT data is present', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue({
        chainId: 42161,
        name: 'Arbitrum One',
        tags: ['L2'],
        l2Beat: { slug: 'arbitrum', stage: 'Stage 1', category: 'Optimistic Rollup' },
      });
      const result = await handleToolCall('get_l2beat_by_id', { chainId: 42161 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(42161);
      expect(data.l2Beat.slug).toBe('arbitrum');
    });

    it('returns an error when the chain has no L2BEAT data', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue({
        chainId: 1,
        name: 'Ethereum',
        tags: [],
      });
      const result = await handleToolCall('get_l2beat_by_id', { chainId: 1 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Not found');
      expect(data.message).toContain('not classified by L2BEAT');
    });

    it('returns an error when the chain does not exist', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue(null);
      const result = await handleToolCall('get_l2beat_by_id', { chainId: 999999 });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Not found');
      expect(data.message).toContain('No chain with chainId');
    });

    it('rejects invalid chainId', async () => {
      const result = await handleToolCall('get_l2beat_by_id', { chainId: 'abc' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chainId');
    });
  });

  describe('handleToolCall - get_refresher_status', () => {
    it('returns the unified refresher status block', async () => {
      const result = await handleToolCall('get_refresher_status', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('lastRefreshAt');
      expect(data).toHaveProperty('lastRefreshSource', 'live');
      expect(data).toHaveProperty('intervalMs');
    });
  });

  describe('getToolDefinitions includes new tools', () => {
    it('exposes the three L2BEAT/scaling/refresher tools', () => {
      const names = getToolDefinitions().map((t) => t.name);
      expect(names).toContain('get_scaling_chains');
      expect(names).toContain('get_l2beat_by_id');
      expect(names).toContain('get_refresher_status');
    });

    it('exposes the three status-page tools', () => {
      const names = getToolDefinitions().map((t) => t.name);
      expect(names).toContain('get_status_pages');
      expect(names).toContain('get_status_page_by_chain');
      expect(names).toContain('get_status_page_by_symbol');
    });

    it('requires chainId for get_status_page_by_chain and symbol for get_status_page_by_symbol', () => {
      const tools = getToolDefinitions();
      expect(tools.find((t) => t.name === 'get_status_page_by_chain').inputSchema.required).toContain('chainId');
      expect(tools.find((t) => t.name === 'get_status_page_by_symbol').inputSchema.required).toContain('symbol');
    });
  });

  describe('handleToolCall - get_status_pages', () => {
    it('returns chain-keyed projects and coin entries with counts', async () => {
      const result = await handleToolCall('get_status_pages', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainCount).toBe(1);
      expect(data.coinCount).toBe(1);
      expect(data.statusPages[0].id).toBe('base');
      expect(data.coins[0].symbol).toBe('SOL');
    });
  });

  describe('handleToolCall - get_status_page_by_chain', () => {
    it('returns the status page covering a chain', async () => {
      const result = await handleToolCall('get_status_page_by_chain', { chainId: 8453 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.statusPage).toBe('https://base-l2.statuspage.io/');
      expect(data.project.name).toBe('Base');
    });

    it('rejects an invalid chain ID', async () => {
      const result = await handleToolCall('get_status_page_by_chain', { chainId: 'nope' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe('Invalid chain ID');
    });

    it('returns an error when no status page covers the chain', async () => {
      const result = await handleToolCall('get_status_page_by_chain', { chainId: 999999 });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe('No status page found for this chain');
    });
  });

  describe('handleToolCall - get_status_page_by_symbol', () => {
    it('returns the status page for a coin symbol (case-insensitive)', async () => {
      const result = await handleToolCall('get_status_page_by_symbol', { symbol: 'sol' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.statusPage).toBe('https://status.solana.com/');
      expect(data.name).toBe('Solana');
    });

    it('requires a non-empty symbol', async () => {
      const result = await handleToolCall('get_status_page_by_symbol', { symbol: '  ' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe('Symbol is required');
    });

    it('returns an error for an unknown symbol', async () => {
      const result = await handleToolCall('get_status_page_by_symbol', { symbol: 'XYZ' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe('No status page found for this symbol');
    });
  });

  describe('handleToolCall - get_live_incidents', () => {
    it('returns incidents with the internal sort key stripped', async () => {
      const result = await handleToolCall('get_live_incidents', { type: 'chain' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(liveIncidents.getLiveIncidents).toHaveBeenCalledWith({
        type: 'chain', chainId: undefined, provider: undefined, limit: undefined,
      });
      expect(data.count).toBe(1);
      expect(data.incidents[0].title).toBe('RPC degraded');
      expect(data.incidents[0]).not.toHaveProperty('publishedMs');
    });

    it('returns isError when the feed is unavailable', async () => {
      vi.mocked(liveIncidents.getLiveIncidents).mockRejectedValueOnce(new Error('down'));
      const result = await handleToolCall('get_live_incidents', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Live incident feed unavailable');
      expect(data.message).toBe('down');
    });
  });

  describe('handleToolCall - get_forum_news', () => {
    it('returns forum news with the internal sort key stripped', async () => {
      const result = await handleToolCall('get_forum_news', { chainId: 1, limit: 5 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(forumNews.getForumNews).toHaveBeenCalledWith({ chainId: 1, forum: undefined, limit: 5 });
      expect(data.news[0].title).toBe('Hash-chain RANDAO');
      expect(data.news[0].forum.id).toBe('ethereum');
      expect(data.news[0]).not.toHaveProperty('publishedMs');
    });

    it('returns isError when the feed is unavailable', async () => {
      vi.mocked(forumNews.getForumNews).mockRejectedValueOnce(new Error('down'));
      const result = await handleToolCall('get_forum_news', {});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toBe('Forum news feed unavailable');
    });
  });
});

