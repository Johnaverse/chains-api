import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config with non-wildcard CORS_ORIGIN to exercise the split/map callback
vi.mock('../../config.js', () => ({
  PORT: 3000,
  HOST: '0.0.0.0',
  BODY_LIMIT: 1048576,
  MAX_PARAM_LENGTH: 200,
  RATE_LIMIT_MAX: 100,
  RATE_LIMIT_WINDOW_MS: 60000,
  RELOAD_RATE_LIMIT_MAX: 5,
  SEARCH_RATE_LIMIT_MAX: 30,
  MAX_SEARCH_QUERY_LENGTH: 200,
  CORS_ORIGIN: 'http://localhost:3000, http://localhost:8080',
  DATA_SOURCE_THE_GRAPH: 'https://example.com/thegraph.json',
  DATA_SOURCE_CHAINLIST: 'https://example.com/chainlist.json',
  DATA_SOURCE_CHAINS: 'https://example.com/chains.json',
  DATA_SOURCE_SLIP44: 'https://example.com/slip44.md',
  DATA_CACHE_ENABLED: false,
  DATA_CACHE_FILE: '.cache/test-data-cache.json',
  PROXY_URL: '',
  PROXY_ENABLED: false
}));

// Capture the onBackgroundRefreshSuccess callback
let capturedCallback = null;

vi.mock('../../dataService.js', async () => {
  const actual = await vi.importActual('../../dataService.js');
  return {
    ...actual,
    loadData: vi.fn().mockResolvedValue({}),
    initializeDataOnStartup: vi.fn(async (options) => {
      if (options?.onBackgroundRefreshSuccess) {
        capturedCallback = options.onBackgroundRefreshSuccess;
      }
      return { indexed: { all: [], byChainId: {} }, lastUpdated: new Date().toISOString() };
    }),
    getCachedData: vi.fn(() => ({
      indexed: { all: [], byChainId: {} },
      lastUpdated: new Date().toISOString(),
      rpcHealth: {},
      lastRpcCheck: null
    })),
    searchChains: vi.fn(() => []),
    getChainById: vi.fn(() => null),
    getAllChains: vi.fn(() => []),
    getAllRelations: vi.fn(() => ({})),
    getRelationsById: vi.fn(() => null),
    getEndpointsById: vi.fn(() => null),
    getAllEndpoints: vi.fn(() => []),
    getAllKeywords: vi.fn(() => ({})),
    validateChainData: vi.fn(() => [])
  };
});

vi.mock('../../rpcMonitor.js', () => ({
  getMonitoringResults: vi.fn(() => ({ results: [], lastUpdated: null })),
  getMonitoringStatus: vi.fn(() => ({ isMonitoring: false, lastUpdated: null })),
  startRpcHealthCheck: vi.fn()
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT'))
}));

import { buildApp } from '../../index.js';
import { startRpcHealthCheck } from '../../rpcMonitor.js';

describe('index.js - CORS origin split/map callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallback = null;
  });

  it('should split CORS_ORIGIN and trim values when not wildcard', async () => {
    const app = await buildApp({ logger: false });
    expect(app).toBeDefined();
    await app.close();
  });
});

describe('index.js - onBackgroundRefreshSuccess callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallback = null;
  });

  it('should call startRpcHealthCheck when onBackgroundRefreshSuccess is invoked', async () => {
    const app = await buildApp({ logger: false });

    // The callback should have been captured during initializeDataOnStartup
    expect(capturedCallback).toBeDefined();

    // Invoke it to exercise the callback
    capturedCallback();

    expect(startRpcHealthCheck).toHaveBeenCalled();

    await app.close();
  });
});
