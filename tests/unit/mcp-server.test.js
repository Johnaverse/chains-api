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
  startRpcHealthCheck: vi.fn(),
}));

// Import mocked functions
import * as dataService from '../../dataService.js';

// Recreate the handler logic from mcp-server.js
const createCallToolHandler = () => async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_chains': {
        let chains = dataService.getAllChains();
        if (args.tag) {
          chains = chains.filter((chain) => chain.tags && chain.tags.includes(args.tag));
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ count: chains.length, chains }, null, 2),
          }],
        };
      }

      case 'get_chain_by_id': {
        const chainId = args.chainId;
        if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid chain ID' }) }],
            isError: true,
          };
        }
        const chain = dataService.getChainById(chainId);
        if (!chain) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Chain not found' }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(chain, null, 2) }],
        };
      }

      case 'search_chains': {
        const query = args.query;
        if (!query) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Query is required' }) }],
            isError: true,
          };
        }
        const results = dataService.searchChains(query);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ query, count: results.length, results }, null, 2),
          }],
        };
      }

      case 'get_endpoints': {
        if (args.chainId !== undefined) {
          const chainId = args.chainId;
          if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid chain ID' }) }],
              isError: true,
            };
          }
          const result = dataService.getEndpointsById(chainId);
          if (!result) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Chain not found' }) }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } else {
          const endpoints = dataService.getAllEndpoints();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ count: endpoints.length, endpoints }, null, 2),
            }],
          };
        }
      }

      case 'get_relations': {
        if (args.chainId !== undefined) {
          const chainId = args.chainId;
          if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid chain ID' }) }],
              isError: true,
            };
          }
          const result = dataService.getRelationsById(chainId);
          if (!result) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Chain not found' }) }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } else {
          const relations = dataService.getAllRelations();
          return {
            content: [{ type: 'text', text: JSON.stringify(relations, null, 2) }],
          };
        }
      }

      case 'get_slip44': {
        const cachedData = dataService.getCachedData();
        if (!cachedData.slip44) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'SLIP-0044 data not loaded' }) }],
            isError: true,
          };
        }
        if (args.coinType !== undefined) {
          const coinType = args.coinType;
          if (typeof coinType !== 'number' || Number.isNaN(coinType)) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid coin type' }) }],
              isError: true,
            };
          }
          const coinTypeData = cachedData.slip44[coinType];
          if (!coinTypeData) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Coin type not found' }) }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(coinTypeData, null, 2) }],
          };
        } else {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                count: Object.keys(cachedData.slip44).length,
                coinTypes: cachedData.slip44,
              }, null, 2),
            }],
          };
        }
      }

      default:
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: 'Internal error', message: error.message }),
      }],
      isError: true,
    };
  }
};

describe('MCP Server Tool Handlers', () => {
  let callToolHandler;

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

    callToolHandler = createCallToolHandler();
  });

  describe('get_chains', () => {
    it('should return all chains without filter', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
        { chainId: 137, name: 'Polygon', tags: ['L2'] },
      ]);

      const result = await callToolHandler({ params: { name: 'get_chains', arguments: {} } });
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

      const result = await callToolHandler({ params: { name: 'get_chains', arguments: { tag: 'L2' } } });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.chains.every((c) => c.tags.includes('L2'))).toBe(true);
    });

    it('should return empty array when no chains match tag', async () => {
      vi.mocked(dataService.getAllChains).mockReturnValue([
        { chainId: 1, name: 'Ethereum', tags: [] },
      ]);

      const result = await callToolHandler({ params: { name: 'get_chains', arguments: { tag: 'Beacon' } } });
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

      const result = await callToolHandler({ params: { name: 'get_chain_by_id', arguments: { chainId: 1 } } });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
      expect(data.name).toBe('Ethereum');
    });

    it('should return error for invalid chain ID type', async () => {
      const result = await callToolHandler({ params: { name: 'get_chain_by_id', arguments: { chainId: 'invalid' } } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error for NaN chain ID', async () => {
      const result = await callToolHandler({ params: { name: 'get_chain_by_id', arguments: { chainId: NaN } } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error for non-existent chain', async () => {
      vi.mocked(dataService.getChainById).mockReturnValue(null);
      const result = await callToolHandler({ params: { name: 'get_chain_by_id', arguments: { chainId: 999999 } } });
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

      const result = await callToolHandler({ params: { name: 'search_chains', arguments: { query: 'ethereum' } } });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.query).toBe('ethereum');
      expect(data.count).toBe(2);
      expect(data.results.length).toBe(2);
    });

    it('should return error when query is missing', async () => {
      const result = await callToolHandler({ params: { name: 'search_chains', arguments: {} } });
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

      const result = await callToolHandler({ params: { name: 'get_endpoints', arguments: {} } });
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

      const result = await callToolHandler({ params: { name: 'get_endpoints', arguments: { chainId: 1 } } });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.chainId).toBe(1);
      expect(data.rpc).toBeDefined();
    });

    it('should return error for invalid chain ID', async () => {
      const result = await callToolHandler({ params: { name: 'get_endpoints', arguments: { chainId: 'invalid' } } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });

    it('should return error when chain not found', async () => {
      vi.mocked(dataService.getEndpointsById).mockReturnValue(null);
      const result = await callToolHandler({ params: { name: 'get_endpoints', arguments: { chainId: 999999 } } });
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

      const result = await callToolHandler({ params: { name: 'get_relations', arguments: {} } });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(2);
    });

    it('should return error for invalid chain ID', async () => {
      const result = await callToolHandler({ params: { name: 'get_relations', arguments: { chainId: 'invalid' } } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid chain ID');
    });
  });

  describe('get_slip44', () => {
    it('should return all coin types', async () => {
      const result = await callToolHandler({ params: { name: 'get_slip44', arguments: {} } });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.coinTypes[60].symbol).toBe('ETH');
    });

    it('should return specific coin type', async () => {
      const result = await callToolHandler({ params: { name: 'get_slip44', arguments: { coinType: 60 } } });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.symbol).toBe('ETH');
      expect(data.name).toBe('Ethereum');
    });

    it('should return error for invalid coin type', async () => {
      const result = await callToolHandler({ params: { name: 'get_slip44', arguments: { coinType: 'invalid' } } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Invalid coin type');
    });

    it('should return error when slip44 data not loaded', async () => {
      vi.mocked(dataService.getCachedData).mockReturnValue({ slip44: null });
      const result = await callToolHandler({ params: { name: 'get_slip44', arguments: {} } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('SLIP-0044 data not loaded');
    });
  });

  describe('error handling', () => {
    it('should return error for unknown tool', async () => {
      const result = await callToolHandler({ params: { name: 'unknown_tool', arguments: {} } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Unknown tool: unknown_tool');
    });

    it('should handle internal errors gracefully', async () => {
      vi.mocked(dataService.getAllChains).mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await callToolHandler({ params: { name: 'get_chains', arguments: {} } });
      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('Internal error');
      expect(data.message).toBe('Database error');
    });
  });
});
