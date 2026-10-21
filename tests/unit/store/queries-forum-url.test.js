import { describe, it, expect, afterEach } from 'vitest';
import { indexData } from '../../../src/store/indexer.js';
import { cachedData } from '../../../src/store/cache.js';
import { getChainById, getAllChains, _resetGetAllChainsCacheForTests } from '../../../src/store/queries.js';

// Regression: transformChain() in queries.js whitelists the fields it emits.
// attachForums() stamps forumUrl onto the raw byChainId objects, but unless
// transformChain explicitly carries it through, forumUrl never reaches the
// API (which was the bug — it was attached but silently dropped on serialize).
describe('queries — forumUrl survives transformChain serialization', () => {
  afterEach(() => {
    cachedData.indexed = null;
    _resetGetAllChainsCacheForTests();
  });

  it('getChainById emits forumUrl for a chain in the registry', () => {
    cachedData.indexed = indexData(null, null, [{ chainId: 1, name: 'Ethereum Mainnet' }], null);
    _resetGetAllChainsCacheForTests();
    expect(getChainById(1).forumUrl).toBe('https://ethereum-magicians.org');
  });

  it('getAllChains emits forumUrl for a chain in the registry', () => {
    cachedData.indexed = indexData(null, null, [{ chainId: 42161, name: 'Arbitrum One' }], null);
    _resetGetAllChainsCacheForTests();
    const chain = getAllChains().find(c => c.chainId === 42161);
    expect(chain.forumUrl).toBe('https://forum.arbitrum.foundation');
  });

  it('omits forumUrl for a chain with no known forum', () => {
    cachedData.indexed = indexData(null, null, [{ chainId: 424242, name: 'Obscure Chain' }], null);
    _resetGetAllChainsCacheForTests();
    expect(getChainById(424242).forumUrl).toBeUndefined();
  });
});

describe('getAllChains memo', () => {
  it('serves a new index even when it loaded in the same millisecond as the last one', () => {
    const saved = { indexed: cachedData.indexed, lastUpdated: cachedData.lastUpdated };
    const index = (chainId) => ({ all: [{ chainId, name: `Chain ${chainId}`, tags: [] }], byChainId: {}, byName: {} });
    try {
      _resetGetAllChainsCacheForTests();
      cachedData.lastUpdated = '2026-10-21T00:00:00.000Z';
      cachedData.indexed = index(1);
      expect(getAllChains().map(c => c.chainId)).toEqual([1]);
      cachedData.indexed = index(2); // same lastUpdated
      expect(getAllChains().map(c => c.chainId)).toEqual([2]);
    } finally {
      Object.assign(cachedData, saved);
      _resetGetAllChainsCacheForTests();
    }
  });
});
