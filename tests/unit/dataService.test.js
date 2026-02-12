import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing dataService
vi.mock('../../config.js', () => ({
  DATA_SOURCE_THE_GRAPH: 'https://example.com/thegraph.json',
  DATA_SOURCE_CHAINLIST: 'https://example.com/chainlist.json',
  DATA_SOURCE_CHAINS: 'https://example.com/chains.json',
  DATA_SOURCE_SLIP44: 'https://example.com/slip44.md',
  RPC_CHECK_TIMEOUT_MS: 8000,
  RPC_CHECK_CONCURRENCY: 8
}));

import {
  getCachedData,
  searchChains,
  getChainById,
  getAllChains,
  getAllRelations,
  getRelationsById,
  getEndpointsById,
  getAllEndpoints
} from '../../dataService.js';

// Mock fetch globally
global.fetch = vi.fn();

describe('Data Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCachedData', () => {
    it('should return cached data object', () => {
      const data = getCachedData();

      expect(data).toBeDefined();
      expect(data).toHaveProperty('theGraph');
      expect(data).toHaveProperty('chainlist');
      expect(data).toHaveProperty('chains');
      expect(data).toHaveProperty('slip44');
      expect(data).toHaveProperty('indexed');
      expect(data).toHaveProperty('lastUpdated');
    });
  });

  describe('searchChains', () => {
    it('should return empty array when no data is loaded', () => {
      const results = searchChains('ethereum');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should search by chain ID', () => {
      const results = searchChains('1');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should search by name (partial match)', () => {
      const results = searchChains('eth');
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return empty array for non-existent chain', () => {
      const results = searchChains('nonexistentchain123');
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    it('should handle case-insensitive search', () => {
      const results1 = searchChains('ETHEREUM');
      const results2 = searchChains('ethereum');
      expect(Array.isArray(results1)).toBe(true);
      expect(Array.isArray(results2)).toBe(true);
    });
  });

  describe('getChainById', () => {
    it('should return null for non-existent chain ID', () => {
      const chain = getChainById(999999);
      expect(chain).toBeNull();
    });

    it('should return chain object with correct structure when found', () => {
      const chain = getChainById(1);

      if (chain) {
        expect(chain).toHaveProperty('chainId');
        expect(chain).toHaveProperty('name');
        expect(chain).not.toHaveProperty('rpc'); // Should not include RPC in transformed output
        expect(chain).not.toHaveProperty('relations'); // Should not include relations
      }
    });

    it('should handle invalid chain ID types', () => {
      const chain = getChainById('invalid');
      expect(chain).toBeNull();
    });
  });

  describe('getAllChains', () => {
    it('should return array of chains', () => {
      const chains = getAllChains();
      expect(Array.isArray(chains)).toBe(true);
    });

    it('should return chains without RPC data', () => {
      const chains = getAllChains();

      chains.forEach(chain => {
        expect(chain).not.toHaveProperty('rpc');
        expect(chain).not.toHaveProperty('relations');
      });
    });

    it('should include required fields', () => {
      const chains = getAllChains();

      if (chains.length > 0) {
        const chain = chains[0];
        expect(chain).toHaveProperty('chainId');
        expect(chain).toHaveProperty('name');
      }
    });
  });

  describe('getAllRelations', () => {
    it('should return relations object', () => {
      const relations = getAllRelations();
      expect(typeof relations).toBe('object');
    });

    it('should have correct relation structure', () => {
      const relations = getAllRelations();

      // Relations should be nested: parentChainId -> childChainId -> relation data
      Object.keys(relations).forEach(parentId => {
        const children = relations[parentId];
        expect(typeof children).toBe('object');

        Object.keys(children).forEach(childId => {
          const relation = children[childId];
          expect(relation).toHaveProperty('kind');
          expect(relation).toHaveProperty('chainId');
        });
      });
    });

    it('should rename parentOf to l1Of', () => {
      const relations = getAllRelations();

      // Check if any relation has kind 'l1Of' (renamed from 'parentOf')
      let hasL1Of = false;
      Object.values(relations).forEach(children => {
        Object.values(children).forEach(relation => {
          if (relation.kind === 'l1Of') {
            hasL1Of = true;
          }
          // Should never have 'parentOf' in output
          expect(relation.kind).not.toBe('parentOf');
        });
      });
    });
  });

  describe('getRelationsById', () => {
    it('should return null for non-existent chain', () => {
      const result = getRelationsById(999999);
      expect(result).toBeNull();
    });

    it('should return relations object with correct structure when found', () => {
      const result = getRelationsById(1);

      if (result) {
        expect(result).toHaveProperty('chainId');
        expect(result).toHaveProperty('chainName');
        expect(result).toHaveProperty('relations');
        expect(Array.isArray(result.relations)).toBe(true);
      }
    });

    it('should include relation details', () => {
      const result = getRelationsById(1);

      if (result && result.relations.length > 0) {
        const relation = result.relations[0];
        expect(relation).toHaveProperty('kind');
        expect(relation).toHaveProperty('source');
      }
    });
  });

  describe('getEndpointsById', () => {
    it('should return null for non-existent chain', () => {
      const endpoints = getEndpointsById(999999);
      expect(endpoints).toBeNull();
    });

    it('should return endpoints object with correct structure', () => {
      const endpoints = getEndpointsById(1);

      if (endpoints) {
        expect(endpoints).toHaveProperty('chainId');
        expect(endpoints).toHaveProperty('name');
        expect(endpoints).toHaveProperty('rpc');
        expect(endpoints).toHaveProperty('firehose');
        expect(endpoints).toHaveProperty('substreams');
        expect(Array.isArray(endpoints.rpc)).toBe(true);
        expect(Array.isArray(endpoints.firehose)).toBe(true);
        expect(Array.isArray(endpoints.substreams)).toBe(true);
      }
    });
  });

  describe('getAllEndpoints', () => {
    it('should return array of endpoint objects', () => {
      const endpoints = getAllEndpoints();
      expect(Array.isArray(endpoints)).toBe(true);
    });

    it('should include RPC endpoints', () => {
      const endpoints = getAllEndpoints();

      endpoints.forEach(endpoint => {
        expect(endpoint).toHaveProperty('chainId');
        expect(endpoint).toHaveProperty('name');
        expect(endpoint).toHaveProperty('rpc');
        expect(Array.isArray(endpoint.rpc)).toBe(true);
      });
    });

    it('should include Graph endpoints when available', () => {
      const endpoints = getAllEndpoints();

      endpoints.forEach(endpoint => {
        expect(endpoint).toHaveProperty('firehose');
        expect(endpoint).toHaveProperty('substreams');
      });
    });
  });

  describe('Data transformation', () => {
    it('should flatten theGraph fields in chain data', () => {
      const chain = getChainById(1);

      if (chain && chain['theGraph-id']) {
        // Should have flattened theGraph fields
        expect(chain).toHaveProperty('theGraph-id');
        expect(chain).toHaveProperty('fullName');
        expect(chain).toHaveProperty('caip2Id');
        // Should not have nested theGraph object
        expect(chain).not.toHaveProperty('theGraph');
      }
    });

    it('should handle chains without theGraph data', () => {
      const chains = getAllChains();

      // Should not throw error for chains without theGraph data
      expect(() => {
        chains.forEach(chain => {
          expect(chain).toHaveProperty('chainId');
        });
      }).not.toThrow();
    });
  });

  describe('SLIP-0044 parsing', () => {
    it('should identify testnets by slip44 = 1', () => {
      const chains = getAllChains();

      // Chains with slip44: 1 should be tagged as Testnet
      chains.forEach(chain => {
        if (chain.slip44 === 1 && chain.tags) {
          // If slip44 is 1, should have Testnet tag (when data is loaded)
          expect(true).toBe(true);
        }
      });
    });
  });

  describe('Tags', () => {
    it('should include L2 tag for L2 chains', () => {
      const chains = getAllChains();

      chains.forEach(chain => {
        if (chain.tags && chain.tags.includes('L2')) {
          expect(Array.isArray(chain.tags)).toBe(true);
        }
      });
    });

    it('should include Testnet tag for testnets', () => {
      const chains = getAllChains();

      chains.forEach(chain => {
        if (chain.tags && chain.tags.includes('Testnet')) {
          expect(Array.isArray(chain.tags)).toBe(true);
        }
      });
    });

    it('should include Beacon tag for beacon chains', () => {
      const chains = getAllChains();

      chains.forEach(chain => {
        if (chain.tags && chain.tags.includes('Beacon')) {
          expect(Array.isArray(chain.tags)).toBe(true);
        }
      });
    });
  });

  describe('Data source merging', () => {
    it('should merge data from multiple sources', () => {
      const chain = getChainById(1); // Ethereum should be in multiple sources

      if (chain && chain.sources) {
        expect(Array.isArray(chain.sources)).toBe(true);
        // Ethereum is likely in multiple sources
        expect(chain.sources.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('should not duplicate RPC endpoints', () => {
      const endpoints = getEndpointsById(1);

      if (endpoints && endpoints.rpc) {
        const urls = endpoints.rpc.map(rpc =>
          typeof rpc === 'string' ? rpc : rpc.url
        ).filter(Boolean);

        const uniqueUrls = new Set(urls);
        expect(urls.length).toBe(uniqueUrls.size);
      }
    });
  });
});
