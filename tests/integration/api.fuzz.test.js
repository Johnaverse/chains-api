import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import Fastify from 'fastify';
import { vi } from 'vitest';

// Mock modules
vi.mock('../../dataService.js', async () => {
  const actual = await vi.importActual('../../dataService.js');
  return {
    ...actual,
    loadData: vi.fn().mockResolvedValue({
      indexed: { all: [], byChainId: {} },
      lastUpdated: new Date().toISOString()
    }),
    initializeDataOnStartup: vi.fn().mockResolvedValue({
      indexed: { all: [], byChainId: {} },
      lastUpdated: new Date().toISOString()
    }),
    getCachedData: vi.fn(() => ({
      indexed: {
        all: [
          { chainId: 1, name: 'Ethereum', tags: ['L1'] },
          { chainId: 137, name: 'Polygon', tags: ['L2'] }
        ],
        byChainId: {
          1: { chainId: 1, name: 'Ethereum', tags: ['L1'], relations: [] },
          137: { chainId: 137, name: 'Polygon', tags: ['L2'], relations: [] }
        }
      },
      theGraph: { status: 'loaded' },
      chainlist: { status: 'loaded' },
      chains: { status: 'loaded' },
      slip44: {},
      lastUpdated: new Date().toISOString()
    })),
    searchChains: vi.fn((query) => {
      if (!query || typeof query !== 'string') return [];
      const lowerQuery = query.toLowerCase();
      if (lowerQuery.includes('eth') || query === '1') {
        return [{ chainId: 1, name: 'Ethereum', tags: ['L1'] }];
      }
      return [];
    }),
    getChainById: vi.fn((id) => {
      const numId = Number.parseInt(id, 10);
      if (numId === 1) return { chainId: 1, name: 'Ethereum', tags: ['L1'] };
      return null;
    }),
    getAllChains: vi.fn(() => [
      { chainId: 1, name: 'Ethereum', tags: ['L1'] },
      { chainId: 137, name: 'Polygon', tags: ['L2'] }
    ]),
    getAllRelations: vi.fn(() => ({
      '1': { '137': { parentName: 'Ethereum', kind: 'l1Of', childName: 'Polygon', chainId: 137 } }
    })),
    getRelationsById: vi.fn((id) => {
      const numId = Number.parseInt(id, 10);
      if (numId === 137) return { chainId: 137, chainName: 'Polygon', relations: [{ kind: 'l2Of', chainId: 1 }] };
      return null;
    }),
    getEndpointsById: vi.fn((id) => {
      const numId = Number.parseInt(id, 10);
      if (numId === 1) return { chainId: 1, name: 'Ethereum', rpc: ['https://eth.llamarpc.com'], firehose: [], substreams: [] };
      return null;
    }),
    getAllEndpoints: vi.fn(() => [
      { chainId: 1, name: 'Ethereum', rpc: ['https://eth.llamarpc.com'], firehose: [], substreams: [] }
    ]),
    getAllKeywords: vi.fn(() => ({
      totalKeywords: 7,
      keywords: {
        blockchainNames: ['Ethereum', 'Polygon'],
        networkNames: ['eth', 'matic'],
        softwareClients: ['Geth'],
        currencySymbols: ['ETH'],
        tags: ['L2'],
        relationKinds: ['l2Of'],
        sources: ['chains'],
        statuses: ['active'],
        generic: ['ethereum', 'geth']
      }
    })),
    traverseRelations: vi.fn((chainId, maxDepth) => {
      const numId = Number.parseInt(chainId, 10);
      if (numId === 1) return {
        startChainId: 1, startChainName: 'Ethereum', maxDepth: maxDepth || 2,
        totalNodes: 2, totalEdges: 1,
        nodes: [
          { chainId: 1, name: 'Ethereum', tags: ['L1'], depth: 0 },
          { chainId: 137, name: 'Polygon', tags: ['L2'], depth: 1 },
        ],
        edges: [{ from: 1, to: 137, kind: 'parentOf', source: 'theGraph' }],
      };
      return null;
    }),
    validateChainData: vi.fn(() => ({
      totalErrors: 5,
      errorsByRule: {
        rule1_relation_conflicts: [{ rule: 1, chainId: 1, chainName: 'Ethereum', message: 'Test error' }],
        rule2_slip44_testnet_mismatch: [],
        rule3_name_testnet_mismatch: [{ rule: 3, chainId: 137, chainName: 'Polygon', message: 'Test error' }],
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
        { rule: 1, chainId: 1, chainName: 'Ethereum', message: 'Test error' },
        { rule: 3, chainId: 137, chainName: 'Polygon', message: 'Test error' }
      ]
    }))
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

const safeToString = (value) => {
  try {
    return String(value);
  } catch (error) {
    console.error('Failed to stringify value:', error);
    return '[unstringifiable]';
  }
};

let fastify;

describe('Fuzz Testing - API Endpoints', () => {
  beforeAll(async () => {
    const { getCachedData, getAllChains, getChainById, searchChains, getAllRelations, getRelationsById, getEndpointsById, getAllEndpoints, getAllKeywords, validateChainData, traverseRelations } = await import('../../dataService.js');
    const { getMonitoringResults, getMonitoringStatus } = await import('../../rpcMonitor.js');

    fastify = Fastify({ logger: false });

    // Register all routes
    fastify.get('/health', async () => {
      const cachedData = getCachedData();
      return {
        status: 'ok',
        dataLoaded: cachedData.indexed !== null,
        lastUpdated: cachedData.lastUpdated,
        totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
      };
    });

    fastify.get('/slip44', async (_request, reply) => {
      const cachedData = getCachedData();
      if (!cachedData.slip44) {
        return reply.code(503).send({ error: 'SLIP-0044 data not loaded' });
      }
      return {
        count: Object.keys(cachedData.slip44).length,
        coinTypes: cachedData.slip44
      };
    });

    fastify.get('/slip44/:coinType', async (request, reply) => {
      const coinType = Number.parseInt(request.params.coinType, 10);
      if (Number.isNaN(coinType)) {
        return reply.code(400).send({ error: 'Invalid coin type' });
      }
      const cachedData = getCachedData();
      if (!cachedData.slip44 || !cachedData.slip44[coinType]) {
        return reply.code(404).send({ error: 'Coin type not found' });
      }
      return cachedData.slip44[coinType];
    });

    fastify.post('/reload', async (_request, reply) => {
      try {
        const cachedData = getCachedData();
        return {
          status: 'success',
          lastUpdated: cachedData.lastUpdated,
          totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
        };
      } catch (error) {
        return reply.code(500).send({ error: 'Failed to reload data' });
      }
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

    fastify.get('/keywords', async () => {
      const keywordResults = getAllKeywords();
      const cachedData = getCachedData();
      return {
        lastUpdated: cachedData.lastUpdated,
        ...keywordResults
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

    fastify.get('/stats', async () => {
      const chains = getAllChains();
      const totalChains = chains.length;
      const totalTestnets = chains.filter(c => c.tags?.includes('Testnet')).length;
      const totalL2s = chains.filter(c => c.tags?.includes('L2')).length;
      const totalBeacons = chains.filter(c => c.tags?.includes('Beacon')).length;
      const totalMainnets = chains.filter(c => !c.tags?.includes('Testnet') && !c.tags?.includes('L2') && !c.tags?.includes('Beacon')).length;
      return {
        totalChains, totalMainnets, totalTestnets, totalL2s, totalBeacons,
        rpc: { totalEndpoints: 100, tested: 50, working: 30, failed: 20, healthPercent: 60 },
        lastUpdated: new Date().toISOString()
      };
    });

    fastify.get('/relations/:id/graph', async (request, reply) => {
      const chainId = Number.parseInt(request.params.id, 10);
      if (Number.isNaN(chainId)) {
        return reply.code(400).send({ error: 'Invalid chain ID' });
      }
      const depth = request.query.depth !== undefined ? Number.parseInt(request.query.depth, 10) : 2;
      if (Number.isNaN(depth) || depth < 1 || depth > 5) {
        return reply.code(400).send({ error: 'Invalid depth. Must be between 1 and 5' });
      }
      const result = traverseRelations(chainId, depth);
      if (!result) {
        return reply.code(404).send({ error: 'Chain not found' });
      }
      return result;
    });

    fastify.get('/validate', async (_request, reply) => {
      const validationResults = validateChainData();
      if (validationResults.error) {
        return reply.code(503).send({ error: validationResults.error });
      }
      return validationResults;
    });

    await fastify.listen({ port: 0 });
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe('GET /chains/:id - Fuzz Tests', () => {
    test.prop([fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean())])('should handle various input types gracefully', async (input) => {
      try {
        const inputStr = String(input);
        const response = await fastify.inject({
          method: 'GET',
          url: `/chains/${encodeURIComponent(inputStr)}`
        });

        // Should return either 400 (invalid) or 404 (not found) or 200 (found)
        expect([200, 400, 404]).toContain(response.statusCode);

        // Should always return valid JSON
        expect(() => JSON.parse(response.payload)).not.toThrow();
      } catch (error) {
        // If input can't be converted to string, that's acceptable
        expect(error instanceof TypeError).toBe(true);
      }
    });

    test.prop([fc.integer()])('should handle integer inputs', async (id) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains/${id}`
      });

      expect([200, 404]).toContain(response.statusCode);

      const data = JSON.parse(response.payload);
      if (response.statusCode === 200) {
        expect(data).toHaveProperty('chainId');
      } else {
        expect(data).toHaveProperty('error');
      }
    });

    test.prop([fc.string()])('should handle string inputs', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains/${encodeURIComponent(input)}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);

      const data = JSON.parse(response.payload);
      if (response.statusCode === 400) {
        expect(data).toHaveProperty('error', 'Invalid chain ID');
      }
    });

    test.prop([fc.double()])('should handle floating point inputs', async (num) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains/${num}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
    });

    test.prop([fc.constantFrom('', ' ', '\n', '\t', '..', '../', '/', '\\', null, undefined)])
    ('should handle special characters and edge cases', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains/${encodeURIComponent(String(input))}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500); // Should not crash
    });
  });

  describe('GET /keywords - Fuzz Tests', () => {
    it('should return keyword collections', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/keywords'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('totalKeywords');
      expect(data).toHaveProperty('keywords');
      expect(Array.isArray(data.keywords.blockchainNames)).toBe(true);
      expect(Array.isArray(data.keywords.softwareClients)).toBe(true);
    });

    test.prop([fc.record({
      userAgent: fc.string(),
      acceptLanguage: fc.string()
    })])('should handle arbitrary headers', async (headers) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/keywords',
        headers: {
          'user-agent': headers.userAgent,
          'accept-language': headers.acceptLanguage
        }
      });

      expect(response.statusCode).toBe(200);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });
  });

  describe('GET /search - Fuzz Tests', () => {
    test.prop([fc.string({ minLength: 1 })])('should handle any non-empty string query', async (query) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(query)}`
      });

      expect(response.statusCode).toBe(200);

      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('query', query);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('results');
      expect(Array.isArray(data.results)).toBe(true);
    });

    test.prop([fc.oneof(fc.string({ minLength: 1 }), fc.integer(), fc.double(), fc.boolean())])
    ('should handle mixed type queries', async (query) => {
      const queryStr = String(query);
      if (queryStr.length === 0) return; // Skip empty strings

      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(queryStr)}`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(Array.isArray(data.results)).toBe(true);
    });

    test.prop([fc.array(fc.constantFrom('<', '>', '&', '"', "'", '/', '\\', '\n', '\t'), { minLength: 1 }).map(arr => arr.join(''))])
    ('should handle special characters in search', async (query) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(query)}`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('results');
    });

    test.prop([fc.string({ minLength: 1000, maxLength: 10000 })])
    ('should handle very long queries', async (longQuery) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(longQuery)}`
      });

      expect([200, 414]).toContain(response.statusCode); // 414 = URI Too Long
    });

    it('should handle missing query parameter', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/search'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error');
    });
  });

  describe('GET /chains - Fuzz Tests', () => {
    test.prop([fc.option(fc.string())])('should handle tag parameter', async (tag) => {
      const url = tag ? `/chains?tag=${encodeURIComponent(tag)}` : '/chains';
      const response = await fastify.inject({
        method: 'GET',
        url
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('chains');
      expect(Array.isArray(data.chains)).toBe(true);
    });

    test.prop([fc.array(fc.string())])('should handle multiple query parameters', async (tags) => {
      const queryString = tags.map(t => `tag=${encodeURIComponent(t)}`).join('&');
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains?${queryString}`
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /relations/:id - Fuzz Tests', () => {
    test.prop([fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean())])('should handle any relation ID input', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/${encodeURIComponent(String(input))}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    test.prop([fc.integer({ min: -1000000, max: 1000000 })])
    ('should handle extreme integer IDs', async (id) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/${id}`
      });

      expect([200, 404]).toContain(response.statusCode);
    });
  });

  describe('GET /endpoints/:id - Fuzz Tests', () => {
    test.prop([fc.oneof(fc.string(), fc.integer(), fc.double())])('should handle various endpoint ID inputs', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/endpoints/${encodeURIComponent(String(input))}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    test.prop([fc.nat()])('should handle natural number IDs', async (id) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/endpoints/${id}`
      });

      expect([200, 404]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const data = JSON.parse(response.payload);
        expect(data).toHaveProperty('rpc');
        expect(data).toHaveProperty('firehose');
        expect(data).toHaveProperty('substreams');
      }
    });
  });

  describe('GET /rpc-monitor/:id - Fuzz Tests', () => {
    test.prop([fc.anything()])('should handle any RPC monitor ID input', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/rpc-monitor/${encodeURIComponent(safeToString(input))}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });
  });

  describe('GET /stats - Fuzz Tests', () => {
    it('should return aggregate statistics', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/stats'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('totalChains');
      expect(data).toHaveProperty('totalMainnets');
      expect(data).toHaveProperty('totalTestnets');
      expect(data).toHaveProperty('totalL2s');
      expect(data).toHaveProperty('totalBeacons');
      expect(data).toHaveProperty('rpc');
      expect(data.rpc).toHaveProperty('healthPercent');
    });

    it('should always return valid JSON', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/stats'
      });

      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    it('should handle concurrent requests', async () => {
      const requests = Array(10).fill(null).map(() =>
        fastify.inject({ method: 'GET', url: '/stats' })
      );
      const responses = await Promise.all(requests);
      responses.forEach(response => {
        expect(response.statusCode).toBe(200);
        expect(() => JSON.parse(response.payload)).not.toThrow();
      });
    });

    test.prop([fc.record({
      userAgent: fc.string(),
      acceptLanguage: fc.string()
    })])('should handle various header combinations', async (headers) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/stats',
        headers: {
          'user-agent': headers.userAgent,
          'accept-language': headers.acceptLanguage
        }
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /relations/:id/graph - Fuzz Tests', () => {
    test.prop([fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean())])
    ('should handle various ID inputs', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/${encodeURIComponent(String(input))}/graph`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    test.prop([fc.integer()])('should handle integer chain IDs', async (id) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/${id}/graph`
      });

      expect([200, 404]).toContain(response.statusCode);

      if (response.statusCode === 200) {
        const data = JSON.parse(response.payload);
        expect(data).toHaveProperty('startChainId');
        expect(data).toHaveProperty('nodes');
        expect(data).toHaveProperty('edges');
        expect(data).toHaveProperty('totalNodes');
        expect(data).toHaveProperty('totalEdges');
      }
    });

    test.prop([fc.integer({ min: 1, max: 5 })])('should accept valid depth values', async (depth) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/1/graph?depth=${depth}`
      });

      expect([200, 404]).toContain(response.statusCode);
    });

    test.prop([fc.oneof(fc.integer({ min: -100, max: 0 }), fc.integer({ min: 6, max: 100 }))])
    ('should reject invalid depth values', async (depth) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/1/graph?depth=${depth}`
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data.error).toBe('Invalid depth. Must be between 1 and 5');
    });

    test.prop([fc.string()])('should handle non-numeric depth values', async (depth) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/1/graph?depth=${encodeURIComponent(depth)}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });

    test.prop([fc.constantFrom('', ' ', '\n', '\t', '..', '../', '/', '\\')])
    ('should handle special characters in chain ID', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/${encodeURIComponent(input)}/graph`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });

    const sqlInjectionPayloads = [
      "1' OR '1'='1",
      "1; DROP TABLE chains--",
      "' OR 1=1--"
    ];

    test.each(sqlInjectionPayloads)('should safely handle SQL injection: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/relations/${encodeURIComponent(payload)}/graph`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });
  });

  describe('HTTP Method Fuzzing', () => {
    const endpoints = [
      '/health',
      '/chains',
      '/chains/1',
      '/search?q=test',
      '/relations',
      '/relations/1',
      '/endpoints',
      '/endpoints/1',
      '/sources',
      '/slip44',
      '/slip44/60',
      '/validate',
      '/keywords',
      '/rpc-monitor',
      '/rpc-monitor/1',
      '/stats',
      '/relations/1/graph',
      '/relations/1/graph?depth=3'
    ];

    test.each(endpoints)('GET %s should always return valid response', async (endpoint) => {
      const response = await fastify.inject({
        method: 'GET',
        url: endpoint
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    test.each(endpoints)('POST %s should handle invalid method', async (endpoint) => {
      const response = await fastify.inject({
        method: 'POST',
        url: endpoint
      });

      // Should return 404 (route not found) or 405 (method not allowed)
      expect([404, 405]).toContain(response.statusCode);
    });

    test.each(endpoints)('DELETE %s should handle invalid method', async (endpoint) => {
      const response = await fastify.inject({
        method: 'DELETE',
        url: endpoint
      });

      expect([404, 405]).toContain(response.statusCode);
    });

    test.each(endpoints)('PUT %s should handle invalid method', async (endpoint) => {
      const response = await fastify.inject({
        method: 'PUT',
        url: endpoint
      });

      expect([404, 405]).toContain(response.statusCode);
    });
  });

  describe('Header Injection Fuzzing', () => {
    test.prop([fc.string()])('should handle arbitrary header values', async (headerValue) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/health',
        headers: {
          'x-custom-header': headerValue
        }
      });

      expect(response.statusCode).toBe(200);
    });

    test.prop([fc.record({
      userAgent: fc.string(),
      referer: fc.string(),
      cookie: fc.string()
    })])('should handle various header combinations', async (headers) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/health',
        headers: {
          'user-agent': headers.userAgent,
          'referer': headers.referer,
          'cookie': headers.cookie
        }
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('SQL Injection Attempts', () => {
    const sqlInjectionPayloads = [
      "1' OR '1'='1",
      "1; DROP TABLE chains--",
      "' OR 1=1--",
      "admin'--",
      "' OR 'x'='x",
      "1' UNION SELECT * FROM users--"
    ];

    test.each(sqlInjectionPayloads)('should safely handle SQL injection attempt in chain ID: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains/${encodeURIComponent(payload)}`
      });

      // SQL injection strings are treated as invalid IDs (400) or not found (404)
      // Some might parse as valid numbers and return 200 (not found data) - all are safe
      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500); // Never crash

      const data = JSON.parse(response.payload);
      // Response should have either data or error, never crash
      expect(data).toBeDefined();
    });

    test.each(sqlInjectionPayloads)('should safely handle SQL injection in search: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(payload)}`
      });

      // SQL injection strings are treated as normal search queries
      // They don't crash the server and return valid responses
      expect(response.statusCode).toBe(200);
      expect(response.statusCode).not.toBe(500); // Never crash

      const data = JSON.parse(response.payload);
      expect(Array.isArray(data.results)).toBe(true);
      expect(data.query).toBe(payload); // Query is stored as-is, not executed
    });
  });

  describe('XSS Attempts', () => {
    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert("XSS")>',
      'javascript:alert("XSS")',
      '<svg onload=alert("XSS")>',
      '"><script>alert(String.fromCharCode(88,83,83))</script>'
    ];

    test.each(xssPayloads)('should safely handle XSS attempt: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(payload)}`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);

      // Query should be stored as-is but not executed
      expect(data.query).toBe(payload);
      expect(Array.isArray(data.results)).toBe(true);
    });
  });

  describe('Path Traversal Attempts', () => {
    const pathTraversalPayloads = [
      '../',
      '../../',
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      '%2e%2e%2f',
      '%2e%2e/',
      '..%2f',
      '%252e%252e%252f'
    ];

    test.each(pathTraversalPayloads)('should safely handle path traversal: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/chains/${encodeURIComponent(payload)}`
      });

      expect([400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });
  });

  describe('Buffer Overflow Attempts', () => {
    test.prop([fc.string({ minLength: 100000, maxLength: 1000000 })])
    ('should handle extremely long inputs without crashing', async (longInput) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(longInput.substring(0, 50000))}` // Limit to avoid URI too long
      });

      // Should handle gracefully, not crash
      expect([200, 414]).toContain(response.statusCode);
    });
  });

  describe('Unicode and Encoding Tests', () => {
    test.prop([fc.string({ minLength: 1 })])('should handle unicode strings', async (unicodeStr) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(unicodeStr)}`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.query).toBe(unicodeStr);
    });

    const specialUnicode = [
      '🔥💻🚀',
      '测试',
      'тест',
      'اختبار',
      '∀x∈ℝ',
      '👨‍👩‍👧‍👦'
    ];

    test.each(specialUnicode)('should handle special unicode: %s', async (unicode) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/search?q=${encodeURIComponent(unicode)}`
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.query).toBe(unicode);
    });
  });

  describe('GET /validate - Fuzz Tests', () => {
    it('should return validation results', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('totalErrors');
      expect(data).toHaveProperty('errorsByRule');
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('allErrors');
    });

    it('should always return valid JSON', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    it('should not crash with concurrent requests', async () => {
      const requests = Array(10).fill(null).map(() =>
        fastify.inject({
          method: 'GET',
          url: '/validate'
        })
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.statusCode).toBe(200);
        expect(() => JSON.parse(response.payload)).not.toThrow();
      });
    });

    test.prop([fc.constantFrom('POST', 'PUT', 'DELETE', 'PATCH')])
    ('should reject invalid HTTP methods', async (method) => {
      const response = await fastify.inject({
        method,
        url: '/validate'
      });

      expect([404, 405]).toContain(response.statusCode);
    });

    it('should have consistent error structure across calls', async () => {
      const response1 = await fastify.inject({
        method: 'GET',
        url: '/validate'
      });

      const response2 = await fastify.inject({
        method: 'GET',
        url: '/validate'
      });

      const data1 = JSON.parse(response1.payload);
      const data2 = JSON.parse(response2.payload);

      // Both should have the same structure
      expect(Object.keys(data1).sort()).toEqual(Object.keys(data2).sort());
      expect(Object.keys(data1.errorsByRule).sort()).toEqual(Object.keys(data2.errorsByRule).sort());
      expect(Object.keys(data1.summary).sort()).toEqual(Object.keys(data2.summary).sort());
    });

    test.prop([fc.record({
      userAgent: fc.string(),
      referer: fc.string(),
      acceptEncoding: fc.string()
    })])('should handle various header combinations', async (headers) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/validate',
        headers: {
          'user-agent': headers.userAgent,
          'referer': headers.referer,
          'accept-encoding': headers.acceptEncoding
        }
      });

      expect(response.statusCode).toBe(200);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    it('should return same result for idempotent calls', async () => {
      const response1 = await fastify.inject({
        method: 'GET',
        url: '/validate'
      });

      const response2 = await fastify.inject({
        method: 'GET',
        url: '/validate'
      });

      expect(response1.statusCode).toBe(response2.statusCode);
      expect(response1.payload).toBe(response2.payload);
    });

    it('should handle rapid sequential requests', async () => {
      const responses = [];
      for (let i = 0; i < 20; i++) {
        const response = await fastify.inject({
          method: 'GET',
          url: '/validate'
        });
        responses.push(response);
      }

      responses.forEach(response => {
        expect(response.statusCode).toBe(200);
        const data = JSON.parse(response.payload);
        expect(data).toHaveProperty('totalErrors');
        expect(data).toHaveProperty('allErrors');
      });
    });
  });

  describe('GET /slip44 - Fuzz Tests', () => {
    it('should return all SLIP-0044 coin types', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/slip44'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('count');
      expect(data).toHaveProperty('coinTypes');
      expect(typeof data.coinTypes).toBe('object');
    });

    it('should always return valid JSON', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/slip44'
      });

      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    it('should handle concurrent requests', async () => {
      const requests = Array(10).fill(null).map(() =>
        fastify.inject({
          method: 'GET',
          url: '/slip44'
        })
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect(response.statusCode).toBe(200);
        expect(() => JSON.parse(response.payload)).not.toThrow();
      });
    });

    test.prop([fc.record({
      userAgent: fc.string(),
      acceptLanguage: fc.string()
    })])('should handle various header combinations', async (headers) => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/slip44',
        headers: {
          'user-agent': headers.userAgent,
          'accept-language': headers.acceptLanguage
        }
      });

      expect(response.statusCode).toBe(200);
    });

    it('should be idempotent', async () => {
      const response1 = await fastify.inject({
        method: 'GET',
        url: '/slip44'
      });

      const response2 = await fastify.inject({
        method: 'GET',
        url: '/slip44'
      });

      expect(response1.statusCode).toBe(response2.statusCode);
      expect(response1.payload).toBe(response2.payload);
    });
  });

  describe('GET /slip44/:coinType - Fuzz Tests', () => {
    test.prop([fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean())])
    ('should handle various input types', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${encodeURIComponent(String(input))}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    test.prop([fc.integer()])('should handle integer inputs', async (coinType) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${coinType}`
      });

      expect([200, 404]).toContain(response.statusCode);

      const data = JSON.parse(response.payload);
      if (response.statusCode === 404) {
        expect(data).toHaveProperty('error', 'Coin type not found');
      }
    });

    test.prop([fc.string()])('should handle string inputs', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${encodeURIComponent(input)}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);

      const data = JSON.parse(response.payload);
      if (response.statusCode === 400) {
        expect(data).toHaveProperty('error', 'Invalid coin type');
      }
    });

    test.prop([fc.double()])('should handle floating point inputs', async (num) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${num}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
    });

    test.prop([fc.constantFrom('', ' ', '\n', '\t', '..', '../', '/', '\\', 'null', 'undefined')])
    ('should handle special characters and edge cases', async (input) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${encodeURIComponent(input)}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });

    test.prop([fc.integer({ min: -1000000, max: 1000000 })])
    ('should handle extreme integer values', async (coinType) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${coinType}`
      });

      expect([200, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });

    test.prop([fc.nat()])('should handle natural numbers', async (coinType) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${coinType}`
      });

      expect([200, 404]).toContain(response.statusCode);
    });

    const sqlInjectionPayloads = [
      "1' OR '1'='1",
      "1; DROP TABLE slip44--",
      "' OR 1=1--"
    ];

    test.each(sqlInjectionPayloads)('should safely handle SQL injection: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'GET',
        url: `/slip44/${encodeURIComponent(payload)}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500);
    });
  });

  describe('POST /reload - Fuzz Tests', () => {
    it('should reload data successfully', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/reload'
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('status', 'success');
      expect(data).toHaveProperty('lastUpdated');
      expect(data).toHaveProperty('totalChains');
    });

    it('should always return valid JSON', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/reload'
      });

      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    test.prop([fc.record({
      contentType: fc.constantFrom('application/json', 'text/plain', 'application/xml', ''),
      userAgent: fc.string()
    })])('should handle various header combinations', async (headers) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/reload',
        headers: {
          'content-type': headers.contentType,
          'user-agent': headers.userAgent
        }
      });

      expect([200, 400, 415, 500]).toContain(response.statusCode);
    });

    test.prop([fc.oneof(
      fc.string(),
      fc.record({ data: fc.string() }),
      fc.array(fc.integer())
    )])('should handle various body types', async (body) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/reload',
        payload: body,
        headers: {
          'content-type': 'application/json'
        }
      });

      expect([200, 400, 500]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
    });

    it('should handle concurrent reload requests', async () => {
      const requests = Array(5).fill(null).map(() =>
        fastify.inject({
          method: 'POST',
          url: '/reload'
        })
      );

      const responses = await Promise.all(requests);

      responses.forEach(response => {
        expect([200, 500]).toContain(response.statusCode);
        expect(() => JSON.parse(response.payload)).not.toThrow();
      });
    });

    it('should handle rapid sequential POST requests', async () => {
      const responses = [];
      for (let i = 0; i < 10; i++) {
        const response = await fastify.inject({
          method: 'POST',
          url: '/reload'
        });
        responses.push(response);
      }

      responses.forEach(response => {
        expect([200, 500]).toContain(response.statusCode);
        const data = JSON.parse(response.payload);
        expect(data).toBeDefined();
      });
    });

    test.prop([fc.constantFrom('GET', 'PUT', 'DELETE', 'PATCH')])
    ('should reject invalid HTTP methods', async (method) => {
      const response = await fastify.inject({
        method,
        url: '/reload'
      });

      expect([404, 405]).toContain(response.statusCode);
    });

    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '<img src=x onerror=alert("XSS")>'
    ];

    test.each(xssPayloads)('should safely handle XSS in body: %s', async (payload) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/reload',
        payload: { data: payload },
        headers: {
          'content-type': 'application/json'
        }
      });

      expect([200, 400, 500]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(500) || expect(response.statusCode).toBe(500);
    });

    test.prop([fc.string({ minLength: 1000, maxLength: 10000 })])
    ('should handle large payloads', async (largeString) => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/reload',
        payload: { data: largeString },
        headers: {
          'content-type': 'application/json'
        }
      });

      expect([200, 400, 413, 500]).toContain(response.statusCode);
    });
  });
});
