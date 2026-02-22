import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dataService before importing
vi.mock('../../dataService.js', () => ({
  loadData: vi.fn().mockResolvedValue(undefined),
  getCachedData: vi.fn(() => ({
    theGraph: null,
    chainlist: null,
    chains: null,
    slip44: {
      0: { symbol: 'BTC', name: 'Bitcoin' },
      60: { symbol: 'ETH', name: 'Ethereum' },
    },
    indexed: { all: [] },
    lastUpdated: new Date().toISOString(),
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
  startRpcHealthCheck: vi.fn(),
  validateChainData: vi.fn(() => ({ totalErrors: 0, errorsByRule: {}, summary: {}, allErrors: [] })),
}));

// Mock rpcMonitor before importing
vi.mock('../../rpcMonitor.js', () => ({
  getMonitoringResults: vi.fn(() => ({
    lastUpdated: null,
    totalEndpoints: 0,
    testedEndpoints: 0,
    workingEndpoints: 0,
    results: [],
  })),
  getMonitoringStatus: vi.fn(() => ({
    isMonitoring: false,
    lastUpdated: null,
  })),
}));

// Import mocked functions and the real shared handler
import * as dataService from '../../dataService.js';
import { handleToolCall } from '../../mcp-tools.js';

describe('MCP Server Tool Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dataService.getCachedData).mockReturnValue({
      theGraph: null,
      chainlist: null,
      chains: null,
      slip44: {
        0: { symbol: 'BTC', name: 'Bitcoin' },
        60: { symbol: 'ETH', name: 'Ethereum' },
      },
      indexed: { all: [] },
      lastUpdated: new Date().toISOString(),
    });
    vi.mocked(dataService.searchChains).mockReturnValue([]);
    vi.mocked(dataService.getChainById).mockReturnValue(null);
    vi.mocked(dataService.getAllChains).mockReturnValue([]);
    vi.mocked(dataService.getAllRelations).mockReturnValue([]);
    vi.mocked(dataService.getRelationsById).mockReturnValue(null);
    vi.mocked(dataService.getEndpointsById).mockReturnValue(null);
    vi.mocked(dataService.getAllEndpoints).mockReturnValue([]);
  });

  describe('get_chains', () => {
    it('should return all chains without filter', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
        { chainId: 137, name: 'Polygon', tags: ['L2'] },
      ]);

      const result = await handleToolCall('get_chains', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.chains.length).toBe(2);
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
      expect(data.chains.every((c) => c.tags.includes('L2'))).toBe(true);
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
  });

  describe('get_chain_by_id', () => {
    it('should return chain by valid ID', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue({
        chainId: 1,
        name: 'Ethereum',
        nativeCurrency: { symbol: 'ETH' },
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
  });

  describe('search_chains', () => {
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
  });

  describe('get_endpoints', () => {
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
        chainId: 1,
        rpc: ['https://eth.rpc'],
      });

      const result = await handleToolCall('get_endpoints', { chainId: 1 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
      expect(data.rpc).toBeDefined();
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

  describe('get_relations', () => {
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

    it('should return error for invalid chain ID', async () => {
      const result = await handleToolCall('get_relations', { chainId: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });
  });

  describe('get_slip44', () => {
    it('should return all coin types', async () => {
      const result = await handleToolCall('get_slip44', {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.coinTypes[60].symbol).toBe('ETH');
    });

    it('should return specific coin type', async () => {
      const result = await handleToolCall('get_slip44', { coinType: 60 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.symbol).toBe('ETH');
      expect(data.name).toBe('Ethereum');
    });

    it('should return error for invalid coin type', async () => {
      const result = await handleToolCall('get_slip44', { coinType: 'invalid' });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid coin type');
    });

    it('should return error when slip44 data not loaded', async () => {
      vi.mocked(dataService.getCachedData).mockReturnValue({ slip44: null });
      const result = await handleToolCall('get_slip44', {});
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('SLIP-0044 data not loaded');
    });
  });

  describe('error handling', () => {
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
});
