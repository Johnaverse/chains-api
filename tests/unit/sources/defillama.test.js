import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../fetchUtil.js', () => ({ proxyFetch: vi.fn() }));
vi.mock('../../../config.js', () => ({
  DATA_SOURCE_DEFILLAMA_CONFIG: 'https://defillama.test/config',
  DEFILLAMA_FETCH_TIMEOUT_MS: 1000
}));

import { proxyFetch } from '../../../fetchUtil.js';
import { fetchDefiLlama, normalizeDefiLlamaConfig } from '../../../src/sources/defillama.js';

const config = (chainCoingeckoIds) => ({ protocols: [], chainCoingeckoIds });

describe('normalizeDefiLlamaConfig', () => {
  it('returns [] for payloads without a chain map', () => {
    expect(normalizeDefiLlamaConfig(null)).toEqual([]);
    expect(normalizeDefiLlamaConfig({})).toEqual([]);
    expect(normalizeDefiLlamaConfig({ chainCoingeckoIds: [] })).toEqual([]);
  });

  it('maps the static metadata of a chain', () => {
    const [base] = normalizeDefiLlamaConfig(config({
      Base: {
        geckoId: null, gasTokenGeckoId: 'ethereum', symbol: null, cmcId: null,
        github: ['base-org'], categories: ['EVM', 'Rollup'],
        parent: { chain: 'Ethereum', types: ['L2', 'gas'], da: 'Ethereum' },
        chainId: 8453, twitter: 'base', url: 'https://www.base.org/',
        dimensions: { fees: 'base' }
      }
    }));
    expect(base).toEqual({
      chainId: 8453, name: 'Base', aliases: [],
      website: 'https://www.base.org/', twitter: 'base', github: ['base-org'],
      symbol: null, gasTokenSymbol: null, geckoId: null, gasTokenGeckoId: 'ethereum', cmcId: null,
      categories: ['EVM', 'Rollup'],
      parent: { chain: 'Ethereum', types: ['L2', 'gas'], da: 'Ethereum' },
      deprecated: false, deadFrom: null
    });
  });

  it('drops entries without a usable chainId and accepts numeric strings and the lowercase key', () => {
    const result = normalizeDefiLlamaConfig(config({
      Solana: { geckoId: 'solana' },
      Evmos: { chainId: '9001' },
      Rollux: { chainid: 570 },
      Broken: { chainId: 'eip155:1' },
      Zero: { chainId: 0 }
    }));
    expect(result.map(c => [c.name, c.chainId])).toEqual([['Evmos', 9001], ['Rollux', 570]]);
  });

  it('collapses renamed labels onto one chain, first label wins', () => {
    const result = normalizeDefiLlamaConfig(config({
      'OP Mainnet': { chainId: 10, symbol: 'OP' },
      Optimism: { chainId: 10, symbol: 'OP' }
    }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'OP Mainnet', aliases: ['Optimism'] });
  });

  it('prefers a live label over a deprecated one for the same chainId', () => {
    const result = normalizeDefiLlamaConfig(config({
      OldName: { chainId: 7, deprecated: true, deadFrom: '2026-01-01' },
      NewName: { chainId: 7 }
    }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'NewName', aliases: ['OldName'], deprecated: false });
  });

  it('keeps a live first label when a later alias is deprecated', () => {
    const [chain] = normalizeDefiLlamaConfig(config({
      NewName: { chainId: 7 },
      OldName: { chainId: 7, deprecated: true }
    }));
    expect(chain).toMatchObject({ name: 'NewName', aliases: ['OldName'], deprecated: false });
  });

  it('sanitises links before they reach API consumers', () => {
    const [chain] = normalizeDefiLlamaConfig(config({
      X: {
        chainId: 5,
        url: 'javascript:alert(1)',
        twitter: ' @Metal_L2 ',
        github: ['good-org', '../evil', 42]
      },
      Y: { chainId: 6, url: 'http://127.0.0.1/admin', twitter: 'has space here' }
    }));
    expect(chain).toMatchObject({ website: null, twitter: 'Metal_L2', github: ['good-org'] });
    const y = normalizeDefiLlamaConfig(config({ Y: { chainId: 6, url: 'http://127.0.0.1/admin', twitter: 'has space here' } }))[0];
    expect(y).toMatchObject({ website: null, twitter: null });
  });

  it('stringifies cmcId and ignores a parent without a chain', () => {
    const [chain] = normalizeDefiLlamaConfig(config({ X: { chainId: 5, cmcId: 1027, parent: { types: ['L2'] } } }));
    expect(chain.cmcId).toBe('1027');
    expect(chain.parent).toBeNull();
  });
});

describe('fetchDefiLlama', () => {
  beforeEach(() => proxyFetch.mockReset());

  it('returns live data when the endpoint answers', async () => {
    proxyFetch.mockResolvedValue({ ok: true, json: async () => config({ Ethereum: { chainId: 1, twitter: 'ethereum' } }) });
    const result = await fetchDefiLlama();
    expect(result.source).toBe('live');
    expect(result.chains).toEqual([expect.objectContaining({ chainId: 1, twitter: 'ethereum' })]);
    expect(proxyFetch).toHaveBeenCalledWith('https://defillama.test/config', expect.any(Object));
  });

  it.each([
    ['a non-2xx status', () => proxyFetch.mockResolvedValue({ ok: false, status: 503, json: async () => config({ Live: { chainId: 1 } }) })],
    ['a payload with no usable chains', () => proxyFetch.mockResolvedValue({ ok: true, json: async () => ({}) })]
  ])('falls back to the checked-in snapshot on %s', async (_label, arrange) => {
    arrange();
    const result = await fetchDefiLlama();
    expect(result.source).toBe('fallback');
    expect(result.chains.length).toBeGreaterThan(100);
    expect(result.chains.find(c => c.chainId === 1)).toMatchObject({ name: 'Ethereum' });
  });

  it('falls back to the checked-in snapshot on a network error', async () => {
    proxyFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    const result = await fetchDefiLlama();
    expect(result.source).toBe('fallback');
    expect(result.chains.length).toBeGreaterThan(100);
  });
});
