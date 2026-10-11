import { describe, it, expect } from 'vitest';
import { getAllForums, getForumByChainId, attachForums } from '../../../src/sources/forums.js';

describe('getAllForums', () => {
  it('returns a non-empty array of forum entries', () => {
    const forums = getAllForums();
    expect(Array.isArray(forums)).toBe(true);
    expect(forums.length).toBeGreaterThan(0);
  });

  it('each entry has required fields', () => {
    for (const f of getAllForums()) {
      expect(typeof f.id).toBe('string');
      expect(typeof f.name).toBe('string');
      expect(typeof f.url).toBe('string');
      expect(f.url).toMatch(/^https?:\/\//);
      expect(Array.isArray(f.chainIds)).toBe(true);
      expect(f.chainIds.length).toBeGreaterThan(0);
    }
  });
});

describe('getForumByChainId', () => {
  it('returns the forum URL for a known chain', () => {
    expect(getForumByChainId(1)).toBe('https://ethereum-magicians.org');
    expect(getForumByChainId(42161)).toBe('https://forum.arbitrum.foundation');
    expect(getForumByChainId(10)).toBe('https://gov.optimism.io');
    expect(getForumByChainId(8453)).toBe('https://gov.optimism.io');
  });

  it('returns null for unknown chainId', () => {
    expect(getForumByChainId(999999999)).toBeNull();
  });

  it('coerces string chainId', () => {
    expect(getForumByChainId('42161')).toBe('https://forum.arbitrum.foundation');
  });

  it('shared forum URL for chains on the same platform', () => {
    // Moonbeam and Moonriver share the same forum
    expect(getForumByChainId(1284)).toBe(getForumByChainId(1285));
    // Astar and Shiden share the same forum
    expect(getForumByChainId(592)).toBe(getForumByChainId(336));
  });
});

describe('attachForums', () => {
  it('stamps forumUrl on matching chains', () => {
    const indexed = {
      byChainId: {
        1: { chainId: 1, name: 'Ethereum' },
        42161: { chainId: 42161, name: 'Arbitrum One' },
        99999: { chainId: 99999, name: 'Unknown' }
      }
    };
    attachForums(indexed);
    expect(indexed.byChainId[1].forumUrl).toBe('https://ethereum-magicians.org');
    expect(indexed.byChainId[42161].forumUrl).toBe('https://forum.arbitrum.foundation');
    expect(indexed.byChainId[99999].forumUrl).toBeUndefined();
  });

  it('removes a forumUrl the registry no longer lists (stale snapshot) and keeps listed ones current', () => {
    const indexed = {
      byChainId: {
        1: { chainId: 1, forumUrl: 'https://old.example' },
        99999: { chainId: 99999, forumUrl: 'https://dropped.example' },
        5: null
      }
    };
    attachForums(indexed);
    expect(indexed.byChainId[1].forumUrl).toBe('https://ethereum-magicians.org');
    expect('forumUrl' in indexed.byChainId[99999]).toBe(false);
  });

  it('is a no-op when indexed has no byChainId', () => {
    expect(() => attachForums({})).not.toThrow();
    expect(() => attachForums(null)).not.toThrow();
    expect(() => attachForums(undefined)).not.toThrow();
  });
});
