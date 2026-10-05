import { describe, it, expect } from 'vitest';
import { indexData, indexDefiLlamaSource } from '../../../src/store/indexer.js';
import { applyDataToCache } from '../../../src/store/cache.js';
import { getChainById, _resetGetAllChainsCacheForTests } from '../../../src/store/queries.js';

const chainsList = () => [
  { chainId: 1, name: 'Ethereum' },
  { chainId: 8453, name: 'Base' }
];

const llama = (chains, source = 'live') => ({ source, fetchedAt: '2026-10-05T00:00:00.000Z', chains });

describe('indexer — DefiLlama integration', () => {
  it('attaches metadata to matching chains by chainId and records the source', () => {
    const indexed = indexData(null, null, chainsList(), null, null, llama([
      { chainId: 8453, name: 'Base', aliases: [], twitter: 'base', website: 'https://www.base.org/', github: ['base-org'] },
      { chainId: 999999, name: 'Unknown', aliases: [] }
    ]));

    expect(indexed.byChainId[8453].defillama).toMatchObject({
      name: 'Base', twitter: 'base', website: 'https://www.base.org/', github: ['base-org'],
      dataFreshness: 'live', fetchedAt: '2026-10-05T00:00:00.000Z'
    });
    expect(indexed.byChainId[8453].defillama).not.toHaveProperty('chainId');
    expect(indexed.byChainId[8453].sources).toContain('defillama');
    expect(indexed.byChainId[1].defillama).toBeUndefined();
    expect(indexed.byChainId[1].sources ?? []).not.toContain('defillama');
    expect(indexed.byChainId[999999]).toBeUndefined();
  });

  it('is a no-op when DefiLlama did not load', () => {
    const indexed = indexData(null, null, chainsList(), null, null, null);
    expect(indexed.byChainId[1].defillama).toBeUndefined();
  });

  it('drops metadata a fresh load no longer carries', () => {
    const indexed = indexData(null, null, chainsList(), null, null, llama([
      { chainId: 1, name: 'Ethereum', aliases: [] },
      { chainId: 8453, name: 'Base', aliases: [] }
    ]));
    indexDefiLlamaSource(llama([{ chainId: 1, name: 'Ethereum', aliases: [] }], 'fallback'), indexed);

    expect(indexed.byChainId[8453].defillama).toBeUndefined();
    expect(indexed.byChainId[8453].sources).not.toContain('defillama');
    expect(indexed.byChainId[1].defillama.dataFreshness).toBe('fallback');
  });

  it('exposes the metadata on the public chain shape', () => {
    const indexed = indexData(null, null, chainsList(), null, null, llama([
      { chainId: 1, name: 'Ethereum', aliases: [], twitter: 'ethereum' }
    ]));
    applyDataToCache({ indexed, lastUpdated: new Date().toISOString() });
    _resetGetAllChainsCacheForTests();

    expect(getChainById(1).defillama).toMatchObject({ twitter: 'ethereum', dataFreshness: 'live' });
    expect(getChainById(8453).defillama).toBeUndefined();
  });
});
