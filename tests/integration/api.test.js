import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { buildApp } from '../../index.js';

// Mock the modules before importing
vi.mock('../../dataService.js', async () => {
  const actual = await vi.importActual('../../dataService.js');
  return {
    ...actual,
    loadData: vi.fn().mockResolvedValue({
      indexed: {
        all: [],
        byChainId: {}
      },
      lastUpdated: new Date().toISOString()
    }),
    getCachedData: vi.fn(() => ({
      indexed: {
        all: [
          {
            chainId: 1,
            name: 'Ethereum Mainnet',
            tags: ['L1'],
            sources: ['chains']
          },
          {
            chainId: 137,
            name: 'Polygon',
            tags: ['L2'],
            sources: ['chainlist']
          },
          {
            chainId: 11155111,
            name: 'Sepolia',
            tags: ['Testnet'],
            sources: ['chainlist']
          }
        ],
        byChainId: {
          1: {
            chainId: 1,
            name: 'Ethereum Mainnet',
            tags: ['L1'],
            sources: ['chains'],
            relations: []
          },
          137: {
            chainId: 137,
            name: 'Polygon',
            tags: ['L2'],
            sources: ['chainlist'],
            relations: [{ kind: 'l2Of', chainId: 1 }]
          },
          11155111: {
            chainId: 11155111,
            name: 'Sepolia',
            tags: ['Testnet'],
            sources: ['chainlist'],
            relations: []
          }
        }
      },
      theGraph: { status: 'loaded' },
      chainlist: { status: 'loaded' },
      chains: { status: 'loaded' },
      slip44: {
        60: { symbol: 'ETH', name: 'Ether' },
        966: { symbol: 'MATIC', name: 'Polygon' }
      },
      lastUpdated: new Date().toISOString()
    })),
    searchChains: vi.fn((query) => {
      const lowerQuery = query.toLowerCase();
      if (lowerQuery.includes('eth') || query === '1') {
        return [{
          chainId: 1,
          name: 'Ethereum Mainnet',
          tags: ['L1']
        }];
      }
      return [];
    }),
    getChainById: vi.fn((id) => {
      if (id === 1) {
        return {
          chainId: 1,
          name: 'Ethereum Mainnet',
          tags: ['L1'],
          sources: ['chains']
        };
      }
      return null;
    }),
    getAllChains: vi.fn(() => [
      {
        chainId: 1,
        name: 'Ethereum Mainnet',
        tags: ['L1']
      },
      {
        chainId: 137,
        name: 'Polygon',
        tags: ['L2']
      },
      {
        chainId: 11155111,
        name: 'Sepolia',
        tags: ['Testnet']
      }
    ]),
    getAllRelations: vi.fn(() => ({
      '1': {
        '137': {
          parentName: 'Ethereum Mainnet',
          kind: 'l1Of',
          childName: 'Polygon',
          chainId: 137
        }
      }
    })),
    getRelationsById: vi.fn((id) => {
      if (id === 137) {
        return {
          chainId: 137,
          chainName: 'Polygon',
          relations: [{ kind: 'l2Of', chainId: 1 }]
        };
      }
      return null;
    }),
    getEndpointsById: vi.fn((id) => {
      if (id === 1) {
        return {
          chainId: 1,
          name: 'Ethereum Mainnet',
          rpc: ['https://eth.llamarpc.com'],
          firehose: [],
          substreams: []
        };
      }
      return null;
    }),
    getAllEndpoints: vi.fn(() => [
      {
        chainId: 1,
        name: 'Ethereum Mainnet',
        rpc: ['https://eth.llamarpc.com'],
        firehose: [],
        substreams: []
      }
    ]),
    validateChainData: vi.fn(() => ({
      totalErrors: 2,
      errorsByRule: {
        rule1_relation_conflicts: [
          {
            rule: 1,
            chainId: 137,
            chainName: 'Polygon',
            message: 'Example validation error'
          }
        ],
        rule2_slip44_testnet_mismatch: [],
        rule3_name_testnet_mismatch: [
          {
            rule: 3,
            chainId: 11155111,
            chainName: 'Sepolia',
            message: 'Name contains testnet keyword'
          }
        ],
        rule4_sepolia_hoodie_issues: [],
        rule5_status_conflicts: [],
        rule6_goerli_not_deprecated: []
      },
      summary: {
        rule1: 1,
        rule2: 0,
        rule3: 1,
        rule4: 0,
        rule5: 0,
        rule6: 0
      },
      allErrors: [
        {
          rule: 1,
          chainId: 137,
          chainName: 'Polygon',
          message: 'Example validation error'
        },
        {
          rule: 3,
          chainId: 11155111,
          chainName: 'Sepolia',
          message: 'Name contains testnet keyword'
        }
      ]
    })),
    getAllKeywords: vi.fn(() => ({
      totalKeywords: 13,
      keywords: {
        blockchainNames: ['Ethereum Mainnet', 'Polygon'],
        networkNames: ['eth', 'matic'],
        softwareClients: ['Geth'],
        currencySymbols: ['ETH', 'MATIC'],
        tags: ['L2', 'Testnet'],
        relationKinds: ['l2Of'],
        sources: ['chainlist', 'chains'],
        statuses: ['active'],
        generic: ['ethereum', 'geth']
      }
    }))
  };
});

vi.mock('../../rpcMonitor.js', () => ({
  getMonitoringResults: vi.fn(() => ({
    lastUpdated: new Date().toISOString(),
    totalEndpoints: 100,
    testedEndpoints: 50,
    workingEndpoints: 30,
    results: [
      {
        chainId: 1,
        chainName: 'Ethereum Mainnet',
        endpoint: 'https://eth.llamarpc.com',
        status: 'working',
        blockNumber: 12345678,
        responseTime: 150
      }
    ]
  })),
  getMonitoringStatus: vi.fn(() => ({
    isMonitoring: false,
    lastUpdated: new Date().toISOString()
  })),
  startRpcHealthCheck: vi.fn()
}));

describe('API Endpoints', () => {
  let app;

  beforeAll(async () => {
    // Build the app without loading data (we're using mocks)
    app = await buildApp({ logger: false, loadDataOnStartup: false });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /', () => {
    it('should return API information', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('name', 'Chains API');
      expect(data).toHaveProperty('version', '1.0.0');
      expect(data).toHaveProperty('description');
      expect(data).toHaveProperty('endpoints');
      expect(data).toHaveProperty('dataSources');
      expect(Array.isArray(data.dataSources)).toBe(true);
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/health'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('status', 'ok');
      expect(data).toHaveProperty('dataLoaded');
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('totalChains');
    });
  });

  describe('GET /chains', () => {
    it('should return all chains', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('chains');
      expect(Array.isArray(data.chains)).toBe(true);
      expect(data.count).toBe(data.chains.length);
      expect(data.count).toBe(3);
    });

    it('should filter chains by L2 tag', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains?tag=L2'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chains');
      expect(data.count).toBe(1);

      // All returned chains should have the L2 tag
      data.chains.forEach(chain => {
        expect(chain.tags).toContain('L2');
      });
    });

    it('should filter chains by Testnet tag', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains?tag=Testnet'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.count).toBe(1);
      expect(data.chains[0].tags).toContain('Testnet');
    });

    it('should return 400 for invalid tag', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains?tag=InvalidTag'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('Invalid tag');
    });
  });

  describe('GET /chains/:id', () => {
    it('should return chain by ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains/1'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId', 1);
      expect(data).toHaveProperty('name', 'Ethereum Mainnet');
    });

    it('should return 404 for non-existent chain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains/999999'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Chain not found');
    });

    it('should return 400 for invalid chain ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains/invalid'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid chain ID');
    });

    it('should handle decimal chain ID by parsing as integer', async () => {
      // Note: Fastify's URL parsing converts '1.5' to '1' before our handler sees it
      const response = await app.inject({
        method: 'GET',
        url: '/chains/1.5'
      });

      // The request is handled as chain ID 1
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId', 1);
    });
  });

  describe('GET /search', () => {
    it('should search chains by query', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/search?q=ethereum'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('query', 'ethereum');
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('results');
      expect(Array.isArray(data.results)).toBe(true);
    });

    it('should return 400 when query parameter is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/search'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('required');
    });

    it('should return empty results for non-existent chain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/search?q=nonexistentchain'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.count).toBe(0);
      expect(data.results.length).toBe(0);
    });

    it('should return 400 for query that is too long', async () => {
      const longQuery = 'a'.repeat(201);
      const response = await app.inject({
        method: 'GET',
        url: `/search?q=${longQuery}`
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('Query too long');
    });
  });

  describe('GET /relations', () => {
    it('should return all relations', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/relations'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(typeof data).toBe('object');
    });
  });

  describe('GET /relations/:id', () => {
    it('should return relations for a chain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/relations/137'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId', 137);
      expect(data).toHaveProperty('chainName', 'Polygon');
      expect(data).toHaveProperty('relations');
      expect(Array.isArray(data.relations)).toBe(true);
    });

    it('should return 404 for chain without relations', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/relations/999999'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Chain not found');
    });

    it('should return 400 for invalid chain ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/relations/invalid'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid chain ID');
    });
  });

  describe('GET /endpoints', () => {
    it('should return all endpoints', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/endpoints'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('endpoints');
      expect(Array.isArray(data.endpoints)).toBe(true);
      expect(data.count).toBe(data.endpoints.length);
    });
  });

  describe('GET /endpoints/:id', () => {
    it('should return endpoints for a chain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/endpoints/1'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId', 1);
      expect(data).toHaveProperty('name');
      expect(data).toHaveProperty('rpc');
      expect(data).toHaveProperty('firehose');
      expect(data).toHaveProperty('substreams');
      expect(Array.isArray(data.rpc)).toBe(true);
    });

    it('should return 404 for non-existent chain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/endpoints/999999'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Chain not found');
    });

    it('should return 400 for invalid chain ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/endpoints/invalid'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid chain ID');
    });
  });

  describe('GET /sources', () => {
    it('should return data sources status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/sources'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('sources');
      expect(data.sources).toHaveProperty('theGraph');
      expect(data.sources).toHaveProperty('chainlist');
      expect(data.sources).toHaveProperty('chains');
      expect(data.sources).toHaveProperty('slip44');
    });
  });

  describe('GET /slip44', () => {
    it('should return all SLIP-0044 coin types', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/slip44'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('coinTypes');
      expect(typeof data.coinTypes).toBe('object');
      expect(data.count).toBeGreaterThan(0);
    });

    it('should return 503 when SLIP-0044 data is not loaded', async () => {
      const { getCachedData } = await import('../../dataService.js');
      const originalImpl = getCachedData.getMockImplementation();

      // Temporarily mock getCachedData to return null slip44
      getCachedData.mockImplementationOnce(() => ({
        indexed: { all: [], byChainId: {} },
        theGraph: {},
        chainlist: {},
        chains: {},
        slip44: null,
        lastUpdated: new Date().toISOString()
      }));

      const response = await app.inject({
        method: 'GET',
        url: '/slip44'
      });

      expect(response.statusCode).toBe(503);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'SLIP-0044 data not loaded');

      // Restore original implementation
      getCachedData.mockImplementation(originalImpl);
    });
  });

  describe('GET /slip44/:coinType', () => {
    it('should return specific SLIP-0044 coin type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/slip44/60'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('symbol');
      expect(data).toHaveProperty('name');
    });

    it('should return 404 for non-existent coin type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/slip44/999999'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Coin type not found');
    });

    it('should return 400 for invalid coin type', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/slip44/invalid'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid coin type');
    });
  });

  describe('POST /reload', () => {
    it('should reload data from sources', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/reload'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('status', 'success');
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('totalChains');
    });

    it('should return 500 on reload error', async () => {
      const { loadData } = await import('../../dataService.js');
      loadData.mockRejectedValueOnce(new Error('Failed to load data'));

      const response = await app.inject({
        method: 'POST',
        url: '/reload'
      });

      expect(response.statusCode).toBe(500);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Failed to reload data');
    });
  });

  describe('GET /rpc-monitor', () => {
    it('should return RPC monitoring results', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/rpc-monitor'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('isMonitoring');
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('totalEndpoints');
      expect(data).toHaveProperty('testedEndpoints');
      expect(data).toHaveProperty('workingEndpoints');
      expect(data).toHaveProperty('results');
      expect(Array.isArray(data.results)).toBe(true);
    });
  });

  describe('GET /keywords', () => {
    it('should return extracted keyword data', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/keywords'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('totalKeywords');
      expect(data).toHaveProperty('keywords');
      expect(data.keywords).toHaveProperty('blockchainNames');
      expect(data.keywords).toHaveProperty('networkNames');
      expect(data.keywords).toHaveProperty('softwareClients');
      expect(data.keywords).toHaveProperty('currencySymbols');
      expect(data.keywords).toHaveProperty('tags');
      expect(data.keywords).toHaveProperty('relationKinds');
      expect(data.keywords).toHaveProperty('sources');
      expect(data.keywords).toHaveProperty('statuses');
      expect(data.keywords).toHaveProperty('generic');
      expect(Array.isArray(data.keywords.blockchainNames)).toBe(true);
      expect(Array.isArray(data.keywords.softwareClients)).toBe(true);
    });
  });

  describe('GET /rpc-monitor/:id', () => {
    it('should return RPC monitoring results for a specific chain', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/rpc-monitor/1'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId', 1);
      expect(data).toHaveProperty('chainName');
      expect(data).toHaveProperty('totalEndpoints');
      expect(data).toHaveProperty('workingEndpoints');
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('endpoints');
      expect(Array.isArray(data.endpoints)).toBe(true);
    });

    it('should return 400 for invalid chain ID', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/rpc-monitor/invalid'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid chain ID');
    });

    it('should return 404 when no results found', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/rpc-monitor/999999'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'No monitoring results found for this chain');
    });
  });

  describe('GET /validate', () => {
    it('should return validation results for chain data', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('totalErrors');
      expect(data).toHaveProperty('errorsByRule');
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('allErrors');
      expect(typeof data.totalErrors).toBe('number');
      expect(Array.isArray(data.allErrors)).toBe(true);
    });

    it('should have proper error structure with all rule categories', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);

      // Check all rule categories exist
      expect(data.errorsByRule).toHaveProperty('rule1_relation_conflicts');
      expect(data.errorsByRule).toHaveProperty('rule2_slip44_testnet_mismatch');
      expect(data.errorsByRule).toHaveProperty('rule3_name_testnet_mismatch');
      expect(data.errorsByRule).toHaveProperty('rule4_sepolia_hoodie_issues');
      expect(data.errorsByRule).toHaveProperty('rule5_status_conflicts');
      expect(data.errorsByRule).toHaveProperty('rule6_goerli_not_deprecated');

      // Check all arrays
      expect(Array.isArray(data.errorsByRule.rule1_relation_conflicts)).toBe(true);
      expect(Array.isArray(data.errorsByRule.rule2_slip44_testnet_mismatch)).toBe(true);
      expect(Array.isArray(data.errorsByRule.rule3_name_testnet_mismatch)).toBe(true);
      expect(Array.isArray(data.errorsByRule.rule4_sepolia_hoodie_issues)).toBe(true);
      expect(Array.isArray(data.errorsByRule.rule5_status_conflicts)).toBe(true);
      expect(Array.isArray(data.errorsByRule.rule6_goerli_not_deprecated)).toBe(true);
    });

    it('should have summary with counts for each rule', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);

      expect(data.summary).toHaveProperty('rule1');
      expect(data.summary).toHaveProperty('rule2');
      expect(data.summary).toHaveProperty('rule3');
      expect(data.summary).toHaveProperty('rule4');
      expect(data.summary).toHaveProperty('rule5');
      expect(data.summary).toHaveProperty('rule6');

      // All should be numbers
      Object.values(data.summary).forEach(count => {
        expect(typeof count).toBe('number');
      });
    });

    it('should match totalErrors with allErrors length', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.totalErrors).toBe(data.allErrors.length);
    });

    it('should return 503 when data is not loaded', async () => {
      const { validateChainData } = await import('../../dataService.js');
      const originalImpl = validateChainData.getMockImplementation();

      // Mock validateChainData to return error
      validateChainData.mockImplementationOnce(() => ({
        error: 'Data not loaded. Please reload data sources first.',
        errors: []
      }));

      const response = await app.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(503);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
      expect(data.error).toContain('Data not loaded');

      // Restore original implementation
      validateChainData.mockImplementation(originalImpl);
    });

    it('should have valid error objects with required fields', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);

      // Check each error has required fields
      data.allErrors.forEach(error => {
        expect(error).toHaveProperty('rule');
        expect(error).toHaveProperty('chainId');
        expect(error).toHaveProperty('chainName');
        expect(error).toHaveProperty('message');
        expect(typeof error.rule).toBe('number');
        expect(typeof error.chainId).toBe('number');
        expect(typeof error.chainName).toBe('string');
        expect(typeof error.message).toBe('string');
      });
    });
  });
});
