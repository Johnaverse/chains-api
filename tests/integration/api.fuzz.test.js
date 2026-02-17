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

let fastify;

describe('Fuzz Testing - API Endpoints', () => {
  beforeAll(async () => {
    const { getCachedData, getAllChains, getChainById, searchChains, getAllRelations, getRelationsById, getEndpointsById, getAllEndpoints } = await import('../../dataService.js');
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
        url: `/rpc-monitor/${encodeURIComponent(String(input))}`
      });

      expect([200, 400, 404]).toContain(response.statusCode);
      expect(() => JSON.parse(response.payload)).not.toThrow();
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
      '/rpc-monitor',
      '/rpc-monitor/1'
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
});
