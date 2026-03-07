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

import * as dataService from '../../dataService.js';
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
    it('should return an array of 13 tools', () => {
      const tools = getToolDefinitions();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(13);
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
      expect(data.chains.length).toBe(2);
      expect(result.isError).toBeUndefined();
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

    it('should return error when no results for chain', async () => {
      vi.mocked(dataService.getRpcMonitoringResults).mockReturnValue({
        lastUpdated: null, totalEndpoints: 0, testedEndpoints: 0,
        workingEndpoints: 0, results: [],
      });

      const result = await handleToolCall('get_rpc_monitor_by_id', { chainId: 999 });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('No monitoring data available yet for chain 999');
    });
  });

  describe('handleToolCall - get_stats', () => {
    it('should return aggregate stats', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
        { chainId: 5, name: 'Goerli', tags: ['Testnet'] },
        { chainId: 137, name: 'Polygon', tags: ['L2'] },
        { chainId: 100, name: 'Gnosis Beacon', tags: ['Beacon'] },
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
});

