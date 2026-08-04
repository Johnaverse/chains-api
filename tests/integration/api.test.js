import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { buildApp } from '../../index.js';
import * as dataService from '../../dataService.js';
import * as fsPromises from 'node:fs/promises';

// Read the real package version (createRequire bypasses the node:fs/promises
// mock below) so this test tracks the single source of truth instead of a
// hardcoded literal that breaks on every release bump.
const { version: PKG_VERSION } = createRequire(import.meta.url)('../../package.json');

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn()
}));

// Shared mock fn instances. Hoisted so multiple vi.mock factories below can
// reference the same identities — the test body uses `dataService.X` while
// route handlers under src/http/ import directly from src/store/, src/domain/,
// src/services/. Hoisting gives us one set of fns wired into all paths.
const mocks = vi.hoisted(() => ({
  loadData: vi.fn(),
  initializeDataOnStartup: vi.fn(),
  getCachedData: vi.fn(),
  searchChains: vi.fn(),
  getChainById: vi.fn(),
  getAllChains: vi.fn(),
  getAllRelations: vi.fn(),
  getRelationsById: vi.fn(),
  traverseRelations: vi.fn(),
  getEndpointsById: vi.fn(),
  getAllEndpoints: vi.fn(),
  validateChainData: vi.fn(),
  getRpcMonitoringResults: vi.fn(),
  getRpcMonitoringStatus: vi.fn(),
  startRpcHealthCheck: vi.fn(),
  runRpcHealthCheck: vi.fn(),
  getAllKeywords: vi.fn(),
  countChainsByTag: vi.fn()
}));

// Mock each src/ module that HTTP route handlers import from. These are the
// real seams now; dataService.js is just a thin re-export facade.
vi.mock('../../src/store/cache.js', () => ({
  cachedData: { theGraph: null, chainlist: null, chains: null, slip44: null, l2beat: null, indexed: null, lastUpdated: null, rpcHealth: {}, lastRpcCheck: null },
  applyDataToCache: vi.fn(),
  getCachedData: mocks.getCachedData
}));

vi.mock('../../src/store/queries.js', () => ({
  searchChains: mocks.searchChains,
  getChainById: mocks.getChainById,
  getAllChains: mocks.getAllChains,
  getEndpointsById: mocks.getEndpointsById,
  getAllEndpoints: mocks.getAllEndpoints,
  countChainsByTag: mocks.countChainsByTag,
  getRpcMonitoringResults: mocks.getRpcMonitoringResults
}));

vi.mock('../../src/domain/relations.js', () => ({
  getAllRelations: mocks.getAllRelations,
  getRelationsById: mocks.getRelationsById,
  traverseRelations: mocks.traverseRelations
}));

vi.mock('../../src/domain/keywords.js', () => ({
  getAllKeywords: mocks.getAllKeywords
}));

vi.mock('../../src/services/loader.js', () => ({
  loadData: mocks.loadData,
  initializeDataOnStartup: mocks.initializeDataOnStartup
}));

vi.mock('../../src/services/rpcHealth.js', () => ({
  startRpcHealthCheck: mocks.startRpcHealthCheck,
  runRpcHealthCheck: mocks.runRpcHealthCheck,
  getRpcMonitoringStatus: mocks.getRpcMonitoringStatus
}));

vi.mock('../../src/services/validation.js', () => ({
  validateChainData: mocks.validateChainData
}));

vi.mock('../../priceService.js', () => ({
  getPricesForChains: vi.fn(async (chainIds) => {
    const map = new Map();
    for (const id of chainIds) {
      map.set(id, id === 1 ? { usd: 2000.5, updatedAt: '2026-05-01T00:00:00.000Z' } : null);
    }
    return map;
  }),
  getPriceForChain: vi.fn(async (chainId) => {
    if (chainId === 1) return { usd: 2000.5, updatedAt: '2026-05-01T00:00:00.000Z' };
    return null;
  }),
  getCoinGeckoId: vi.fn(() => null),
  clearPriceCache: vi.fn(),
  prefetchAllPrices: vi.fn(async () => {})
}));

vi.mock('../../clientsView.js', () => ({
  getClientsByChain: vi.fn((chainId) => {
    const samples = {
      1: {
        chainId: 1,
        chainName: 'Ethereum Mainnet',
        totalNodes: 2,
        unknownNodes: 0,
        clients: [{
          name: 'geth', repo: 'ethereum/go-ethereum', language: 'Go',
          website: 'https://geth.ethereum.org', layer: 'execution', known: true,
          nodeCount: 2, versions: [{ version: 'v1.14.5', nodeCount: 2 }]
        }]
      },
      137: {
        chainId: 137,
        chainName: 'Polygon',
        totalNodes: 1,
        unknownNodes: 0,
        clients: [{
          name: 'bor', repo: 'maticnetwork/bor', language: 'Go',
          website: 'https://polygon.technology', layer: 'execution', known: true,
          nodeCount: 1, versions: [{ version: 'v1.3.0', nodeCount: 1 }]
        }]
      }
    };
    if (chainId === undefined) return Object.values(samples);
    return samples[chainId] ?? null;
  }),
  summarizeChainClients: vi.fn((chainResults) => {
    if (!chainResults || chainResults.length === 0) return null;
    return {
      chainId: chainResults[0].chainId,
      chainName: chainResults[0].chainName,
      totalNodes: chainResults.length,
      unknownNodes: 0,
      clients: [{
        name: 'geth', repo: 'ethereum/go-ethereum', language: 'Go',
        website: 'https://geth.ethereum.org', layer: 'execution', known: true,
        nodeCount: chainResults.length,
        versions: [{ version: 'v1.14.5', nodeCount: chainResults.length }]
      }]
    };
  })
}));

// Set default implementations for the hoisted mocks. Can't do this in
// vi.hoisted() because closures over the data would be re-created each
// suite; this gives us one stable set used everywhere.
function installMockDefaults() {
  mocks.loadData.mockResolvedValue({
    indexed: { all: [], byChainId: {} },
    lastUpdated: new Date().toISOString()
  });
  mocks.initializeDataOnStartup.mockResolvedValue({
    indexed: { all: [], byChainId: {} },
    lastUpdated: new Date().toISOString()
  });
  mocks.getCachedData.mockImplementation(() => ({
    indexed: {
      all: [
        { chainId: 1, name: 'Ethereum Mainnet', tags: ['L1'], sources: ['chains'] },
        { chainId: 137, name: 'Polygon', tags: ['L2'], sources: ['chainlist'] },
        { chainId: 11155111, name: 'Sepolia', tags: ['Testnet'], sources: ['chainlist'] }
      ],
      byChainId: {
        1: { chainId: 1, name: 'Ethereum Mainnet', tags: ['L1'], sources: ['chains'], relations: [] },
        137: { chainId: 137, name: 'Polygon', tags: ['L2'], sources: ['chainlist'], relations: [{ kind: 'l2Of', chainId: 1 }] },
        11155111: { chainId: 11155111, name: 'Sepolia', tags: ['Testnet'], sources: ['chainlist'], relations: [] }
      }
    },
    theGraph: { status: 'loaded' },
    chainlist: { status: 'loaded' },
    chains: { status: 'loaded' },
    slip44: { 60: { symbol: 'ETH', name: 'Ether' }, 966: { symbol: 'MATIC', name: 'Polygon' } },
    l2beat: { source: 'live', fetchedAt: new Date().toISOString(), projects: [{ slug: 'arbitrum', chainId: 42161, displayName: 'Arbitrum One' }] },
    lastUpdated: new Date().toISOString()
  }));
  mocks.searchChains.mockImplementation((query) => {
    const lowerQuery = query.toLowerCase();
    if (lowerQuery.includes('eth') || query === '1') {
      return [{ chainId: 1, name: 'Ethereum Mainnet', tags: ['L1'] }];
    }
    return [];
  });
  mocks.getChainById.mockImplementation((id) => {
    if (id === 1) return { chainId: 1, name: 'Ethereum Mainnet', tags: ['L1'], sources: ['chains'] };
    return null;
  });
  mocks.getAllChains.mockReturnValue([
    { chainId: 1, name: 'Ethereum Mainnet', tags: ['L1'] },
    { chainId: 137, name: 'Polygon', tags: ['L2'] },
    { chainId: 11155111, name: 'Sepolia', tags: ['Testnet'] }
  ]);
  mocks.getAllRelations.mockReturnValue({
    '1': { '137': { parentName: 'Ethereum Mainnet', kind: 'l1Of', childName: 'Polygon', chainId: 137 } }
  });
  mocks.getRelationsById.mockImplementation((id) => {
    if (id === 137) return { chainId: 137, chainName: 'Polygon', relations: [{ kind: 'l2Of', chainId: 1 }] };
    return null;
  });
  mocks.traverseRelations.mockReturnValue(null);
  mocks.getEndpointsById.mockImplementation((id) => {
    if (id === 1) {
      return { chainId: 1, name: 'Ethereum Mainnet', rpc: ['https://eth.llamarpc.com'], firehose: [], substreams: [] };
    }
    return null;
  });
  mocks.getAllEndpoints.mockReturnValue([
    { chainId: 1, name: 'Ethereum Mainnet', rpc: ['https://eth.llamarpc.com'], firehose: [], substreams: [] }
  ]);
  mocks.validateChainData.mockReturnValue({
    totalErrors: 2,
    errorsByRule: {
      rule1_relation_conflicts: [{ rule: 1, chainId: 137, chainName: 'Polygon', message: 'Example validation error' }],
      rule2_slip44_testnet_mismatch: [],
      rule3_name_testnet_mismatch: [{ rule: 3, chainId: 11155111, chainName: 'Sepolia', message: 'Name contains testnet keyword' }],
      rule4_sepolia_hoodie_issues: [],
      rule5_status_conflicts: [],
      rule6_goerli_not_deprecated: []
    },
    summary: { rule1: 1, rule2: 0, rule3: 1, rule4: 0, rule5: 0, rule6: 0 },
    allErrors: [
      { rule: 1, chainId: 137, chainName: 'Polygon', message: 'Example validation error' },
      { rule: 3, chainId: 11155111, chainName: 'Sepolia', message: 'Name contains testnet keyword' }
    ]
  });
  mocks.getRpcMonitoringResults.mockReturnValue({
    lastUpdated: new Date().toISOString(),
    totalEndpoints: 100,
    testedEndpoints: 50,
    workingEndpoints: 30,
    failedEndpoints: 20,
    results: [
      { chainId: 1, chainName: 'Ethereum Mainnet', url: 'https://eth.llamarpc.com', status: 'working', blockNumber: 12345678, latencyMs: 150, error: null }
    ]
  });
  mocks.getRpcMonitoringStatus.mockReturnValue({ isMonitoring: false, lastUpdated: new Date().toISOString() });
  mocks.getAllKeywords.mockReturnValue({
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
  });
  mocks.countChainsByTag.mockReturnValue({
    totalChains: 3,
    totalMainnets: 1,
    totalTestnets: 1,
    totalL2s: 1,
    totalBeacons: 0,
    byStatus: { active: 2, deprecated: 1 },
    activeChains: 2,
    deprecatedChains: 1
  });
}

installMockDefaults();

// Legacy test references: `dataService.X` still resolves to the same hoisted
// mock fn instance because dataService.js re-exports from the mocked src/
// modules. No code change needed in the test bodies below.

describe('API Endpoints', () => {
  let app;

  beforeAll(async () => {
    // Build the app without loading data (we're using mocks)
    app = await buildApp({ logger: false, loadDataOnStartup: false });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Startup Initialization', () => {
    it('should warm-start using initializeDataOnStartup and serve endpoints immediately', async () => {
      vi.mocked(dataService.initializeDataOnStartup).mockClear();
      vi.mocked(dataService.startRpcHealthCheck).mockClear();

      const startupApp = await buildApp({ logger: false, loadDataOnStartup: true });
      const response = await startupApp.inject({
        method: 'GET',
        url: '/health'
      });

      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload).toHaveProperty('status', 'ok');
      expect(payload).toHaveProperty('dataLoaded');
      expect(payload).toHaveProperty('totalChains');
      expect(vi.mocked(dataService.initializeDataOnStartup)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(dataService.startRpcHealthCheck)).toHaveBeenCalled();

      await startupApp.close();
    });
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
      expect(data).toHaveProperty('version', PKG_VERSION);
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

    it('exposes per-source freshness and per-refresher status', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      const data = JSON.parse(response.payload);

      expect(data.sources).toBeDefined();
      for (const source of ['theGraph', 'chainlist', 'chains', 'slip44', 'l2beat']) {
        expect(data.sources[source]).toHaveProperty('loaded');
        expect(data.sources[source]).toHaveProperty('ageSeconds');
      }

      expect(data.refreshers).toBeDefined();
      expect(data.refreshers.rpc).toHaveProperty('isRunning');
      expect(data.refreshers.l2beat).toHaveProperty('lastRefreshAt');
      expect(data.refreshers.l2beat).toHaveProperty('intervalMs');
    });

    it('reports the running version so a deploy is identifiable from the API', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(JSON.parse(response.payload).version).toBe(PKG_VERSION);
    });
  });

  describe('GET /ready', () => {
    it('is ready once the index is loaded', async () => {
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toMatchObject({ status: 'ok', dataLoaded: true });
      expect(data).toHaveProperty('totalChains');
    });

    it('503s before the first load so a starting pod stays out of the Service', async () => {
      // /health would still be 200 here (liveness) — readiness is what must fail.
      mocks.getCachedData.mockReturnValueOnce({ indexed: null, lastUpdated: null });
      const response = await app.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.payload)).toMatchObject({ status: 'starting', dataLoaded: false });
    });
  });

  describe('GET /refresher', () => {
    it('returns the unified refresher status block', async () => {
      const response = await app.inject({ method: 'GET', url: '/refresher' });
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);

      expect(data).toHaveProperty('tickIntervalMs');
      expect(data).toHaveProperty('isTickInFlight');
      expect(data).toHaveProperty('queueDepth');
      expect(data).toHaveProperty('sweep');
      expect(data.sweep).toHaveProperty('sweepNumber');
      expect(data).toHaveProperty('l2beat');
      expect(data).toHaveProperty('rpc');
    });
  });

  describe('Assistant (disabled in the default test env)', () => {
    it('GET /assistant reports disabled', async () => {
      const response = await app.inject({ method: 'GET', url: '/assistant' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ enabled: false, model: null, reachable: null, timeoutMs: null });
    });

    it('POST /assistant/chat returns 503 when not configured', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/assistant/chat',
        payload: { messages: [{ role: 'user', content: 'hello' }] }
      });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.payload).error).toBe('Assistant not configured');
    });

    it('GET /health omits the assistant key when disabled', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(JSON.parse(response.payload)).not.toHaveProperty('assistant');
    });
  });

  describe('GET /metrics', () => {
    it('returns Prometheus exposition format with text/plain content type', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/text\/plain/);
      expect(response.body).toContain('# HELP chains_api_chains_total');
      expect(response.body).toContain('# TYPE chains_api_chains_total gauge');
    });

    it('includes a source-loaded gauge for each of the 5 sources', async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      for (const source of ['theGraph', 'chainlist', 'chains', 'slip44', 'l2beat']) {
        expect(response.body).toContain(`chains_api_source_loaded{source="${source}"}`);
      }
    });
  });

  describe('GET /stats', () => {
    it('reports the lifecycle breakdown (active/deprecated/byStatus)', async () => {
      const response = await app.inject({ method: 'GET', url: '/stats' });
      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.totalChains).toBe(3);
      expect(data.activeChains).toBe(2);
      expect(data.deprecatedChains).toBe(1);
      expect(data.byStatus).toEqual({ active: 2, deprecated: 1 });
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

    it('should return 400 for unknown query parameters (schema additionalProperties)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains?tags=L2'  // typo: should be ?tag=
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data.error).toContain('Unknown query parameter');
      expect(data.error).toContain('tags');
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

    it('should reject partially numeric chain IDs', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/chains/1abc'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid chain ID');
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

    it('should reject partially numeric graph depth values', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/relations/1/graph?depth=2xyz'
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Invalid depth. Must be between 1 and 5');
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

  describe('GET /export', () => {
    beforeEach(() => {
      // /export stats the cache file to derive its ETag before reading it.
      vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1750000000000, size: 4096 });
    });

    it('should return cached snapshot export when file exists', async () => {
      const mockExport = {
        schemaVersion: 1,
        writtenAt: '2026-02-23T00:00:00.000Z',
        data: {
          indexed: { all: [{ chainId: 1 }], byChainId: { 1: { chainId: 1 } }, byName: {} },
          lastUpdated: '2026-02-23T00:00:00.000Z'
        }
      };

      vi.mocked(fsPromises.readFile).mockResolvedValueOnce(JSON.stringify(mockExport));

      const response = await app.inject({
        method: 'GET',
        url: '/export'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('attachment; filename=');
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('schemaVersion', 1);
      expect(data).toHaveProperty('data');
    });

    it('should return 404 when export file does not exist', async () => {
      vi.mocked(fsPromises.readFile).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      const response = await app.inject({
        method: 'GET',
        url: '/export'
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Export file not found');
    });

    it('should return 500 when export file contains invalid JSON', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValueOnce('{invalid-json');

      const response = await app.inject({
        method: 'GET',
        url: '/export'
      });

      expect(response.statusCode).toBe(500);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('error', 'Export file is not valid JSON');
    });

    it('should serve an ETag and answer a matching If-None-Match with 304', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('{"schemaVersion":1}');

      const first = await app.inject({ method: 'GET', url: '/export' });
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag;
      expect(etag).toMatch(/^".+"$/);
      expect(first.headers['cache-control']).toContain('max-age=60');

      // Same mtime+size → same ETag → 304 without a body.
      const second = await app.inject({
        method: 'GET',
        url: '/export',
        headers: { 'if-none-match': etag }
      });
      expect(second.statusCode).toBe(304);
      expect(second.payload).toBe('');
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



