import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

// Create a test server
let fastify;
let serverAddress;

// Mock the modules before importing
import { vi } from 'vitest';

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
          }
        }
      },
      theGraph: { status: 'loaded' },
      chainlist: { status: 'loaded' },
      chains: { status: 'loaded' },
      slip44: {},
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
    ])
  };
});

vi.mock('../../rpcMonitor.js', () => ({
  getMonitoringResults: vi.fn(() => ({
    lastUpdated: new Date().toISOString(),
    totalEndpoints: 100,
    testedEndpoints: 50,
    workingEndpoints: 30,
    results: []
  })),
  getMonitoringStatus: vi.fn(() => ({
    isMonitoring: false,
    lastUpdated: new Date().toISOString()
  })),
  startRpcHealthCheck: vi.fn()
}));

describe('API Endpoints', () => {
  beforeAll(async () => {
    // Import after mocks are set up
    const { getCachedData, getAllChains, getChainById, searchChains, getAllRelations, getRelationsById, getEndpointsById, getAllEndpoints } = await import('../../dataService.js');
    const { getMonitoringResults, getMonitoringStatus } = await import('../../rpcMonitor.js');

    fastify = Fastify({ logger: false });

    // Register routes (simplified version of index.js routes)
    fastify.get('/health', async () => {
      const cachedData = getCachedData();
      return {
        status: 'ok',
        dataLoaded: cachedData.indexed !== null,
        lastUpdated: cachedData.lastUpdated,
        totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
      };
    });

    fastify.get('/chains', async (request) => {
      const { tag } = request.query;
      let chains = getAllChains();

      if (tag) {
        chains = chains.filter(chain => chain.tags && chain.tags.includes(tag));
      }

      return { count: chains.length, chains };
    });

    fastify.get('/chains/:id', async (request, reply) => {
      const chainId = Number.parseInt(request.params.id, 10);

      if (Number.isNaN(chainId)) {
        return reply.code(400).send({ error: 'Invalid chain ID' });
      }

      const chain = getChainById(chainId);

      if (!chain) {
        return reply.code(404).send({ error: 'Chain not found' });
      }

      return chain;
    });

    fastify.get('/search', async (request, reply) => {
      const { q } = request.query;

      if (!q) {
        return reply.code(400).send({ error: 'Query parameter "q" is required' });
      }

      const results = searchChains(q);

      return { query: q, count: results.length, results };
    });

    fastify.get('/relations', async () => {
      return getAllRelations();
    });

    fastify.get('/relations/:id', async (request, reply) => {
      const chainId = Number.parseInt(request.params.id, 10);

      if (Number.isNaN(chainId)) {
        return reply.code(400).send({ error: 'Invalid chain ID' });
      }

      const result = getRelationsById(chainId);

      if (!result) {
        return reply.code(404).send({ error: 'Chain not found' });
      }

      return result;
    });

    fastify.get('/endpoints', async () => {
      const endpoints = getAllEndpoints();
      return { count: endpoints.length, endpoints };
    });

    fastify.get('/endpoints/:id', async (request, reply) => {
      const chainId = Number.parseInt(request.params.id, 10);

      if (Number.isNaN(chainId)) {
        return reply.code(400).send({ error: 'Invalid chain ID' });
      }

      const result = getEndpointsById(chainId);

      if (!result) {
        return reply.code(404).send({ error: 'Chain not found' });
      }

      return result;
    });

    fastify.get('/sources', async () => {
      const cachedData = getCachedData();
      return {
        lastUpdated: cachedData.lastUpdated,
        sources: {
          theGraph: cachedData.theGraph ? 'loaded' : 'not loaded',
          chainlist: cachedData.chainlist ? 'loaded' : 'not loaded',
          chains: cachedData.chains ? 'loaded' : 'not loaded',
          slip44: cachedData.slip44 ? 'loaded' : 'not loaded'
        }
      };
    });

    fastify.get('/rpc-monitor', async () => {
      const results = getMonitoringResults();
      const status = getMonitoringStatus();

      return { ...status, ...results };
    });

    fastify.get('/rpc-monitor/:id', async (request, reply) => {
      const chainId = Number.parseInt(request.params.id, 10);

      if (Number.isNaN(chainId)) {
        return reply.code(400).send({ error: 'Invalid chain ID' });
      }

      const results = getMonitoringResults();
      const chainResults = results.results.filter(r => r.chainId === chainId);

      if (chainResults.length === 0) {
        return reply.code(404).send({ error: 'No monitoring results found for this chain' });
      }

      return {
        chainId,
        chainName: chainResults[0].chainName,
        totalEndpoints: chainResults.length,
        workingEndpoints: chainResults.filter(r => r.status === 'working').length,
        lastUpdated: results.lastUpdated,
        endpoints: chainResults
      };
    });

    await fastify.listen({ port: 0 }); // Random available port
    serverAddress = `http://localhost:${fastify.server.address().port}`;
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await fastify.inject({
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
      const response = await fastify.inject({
        method: 'GET',
        url: '/chains'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('chains');
      expect(Array.isArray(data.chains)).toBe(true);
      expect(data.count).toBe(data.chains.length);
    });

    it('should filter chains by tag', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/chains?tag=L2'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chains');

      // All returned chains should have the L2 tag
      data.chains.forEach(chain => {
        expect(chain.tags).toContain('L2');
      });
    });
  });

  describe('GET /chains/:id', () => {
    it('should return chain by ID', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/chains/1'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId', 1);
      expect(data).toHaveProperty('name');
    });

    it('should return 404 for non-existent chain', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/chains/999999'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
    });

    it('should return 400 for invalid chain ID', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/chains/invalid'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid chain ID');
    });
  });

  describe('GET /search', () => {
    it('should search chains by query', async () => {
      const response = await fastify.inject({
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
      const response = await fastify.inject({
        method: 'GET',
        url: '/search'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
    });

    it('should return empty results for non-existent chain', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/search?q=nonexistentchain'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.count).toBe(0);
      expect(data.results.length).toBe(0);
    });
  });

  describe('GET /relations', () => {
    it('should return all relations', async () => {
      const response = await fastify.inject({
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
      const response = await fastify.inject({
        method: 'GET',
        url: '/relations/137'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId');
      expect(data).toHaveProperty('chainName');
      expect(data).toHaveProperty('relations');
      expect(Array.isArray(data.relations)).toBe(true);
    });

    it('should return 404 for chain without relations', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/relations/999999'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /endpoints', () => {
    it('should return all endpoints', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/endpoints'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('endpoints');
      expect(Array.isArray(data.endpoints)).toBe(true);
    });
  });

  describe('GET /endpoints/:id', () => {
    it('should return endpoints for a chain', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/endpoints/1'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('chainId');
      expect(data).toHaveProperty('name');
      expect(data).toHaveProperty('rpc');
      expect(data).toHaveProperty('firehose');
      expect(data).toHaveProperty('substreams');
    });

    it('should return 404 for non-existent chain', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/endpoints/999999'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /sources', () => {
    it('should return data sources status', async () => {
      const response = await fastify.inject({
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

  describe('GET /rpc-monitor', () => {
    it('should return RPC monitoring results', async () => {
      const response = await fastify.inject({
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
    });
  });

  describe('GET /rpc-monitor/:id', () => {
    it('should return 400 for invalid chain ID', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/rpc-monitor/invalid'
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 404 when no results found', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/rpc-monitor/999999'
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
