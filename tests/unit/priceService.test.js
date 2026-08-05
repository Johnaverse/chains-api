import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({
  PRICE_CACHE_TTL_MS: 3600000,
  PRICE_NEGATIVE_CACHE_TTL_MS: 300000,
  PRICE_FETCH_TIMEOUT_MS: 3000,
  PRICE_STALE_AFTER_MS: 86400000,
  PROXY_URL: '',
  PROXY_ENABLED: false,
}));

vi.mock('../../fetchUtil.js', () => ({
  proxyFetch: vi.fn(),
}));

import * as fetchUtil from '../../fetchUtil.js';
import {
  getPriceForChain,
  getPricesForChains,
  getCoinGeckoId,
  clearPriceCache,
} from '../../priceService.js';

describe('priceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPriceCache();
  });

  describe('getCoinGeckoId', () => {
    it('should return ethereum for chainId 1', () => {
      expect(getCoinGeckoId(1)).toBe('ethereum');
    });

    it('should return null for unknown chain', () => {
      expect(getCoinGeckoId(99999)).toBeNull();
    });

    it('should return ethereum for Base (8453)', () => {
      expect(getCoinGeckoId(8453)).toBe('ethereum');
    });

    // POL, not MATIC: chain 137's native currency migrated, and CoinGecko still serves a
    // matic-network quote that stopped moving in Feb 2026 — so the old id was not merely
    // outdated, it was a live-looking wrong answer.
    it('should return polygon-ecosystem-token for Polygon (137)', () => {
      expect(getCoinGeckoId(137)).toBe('polygon-ecosystem-token');
    });
  });

  describe('getPriceForChain', () => {
    it('should return null for unknown chain without fetching', async () => {
      const result = await getPriceForChain(99999);
      expect(result).toBeNull();
      expect(fetchUtil.proxyFetch).not.toHaveBeenCalled();
    });

    it('should fetch and return price for known chain', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 2000.5 } }),
      });
      const result = await getPriceForChain(1);
      expect(result).toMatchObject({ usd: 2000.5 });
      expect(result.updatedAt).toBeDefined();
      expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should return null gracefully on CoinGecko HTTP error', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: false,
        status: 429,
      });
      const result = await getPriceForChain(1);
      expect(result).toBeNull();
    });

    it('should return null gracefully on network error', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockRejectedValue(
        new Error('ECONNREFUSED')
      );
      const result = await getPriceForChain(1);
      expect(result).toBeNull();
    });

    it('should retry upstream on next call after a fetch failure', async () => {
      vi.mocked(fetchUtil.proxyFetch)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ethereum: { usd: 2500.0 } }),
        });

      const first = await getPriceForChain(1);
      expect(first).toBeNull();

      const second = await getPriceForChain(1);
      expect(second).toMatchObject({ usd: 2500.0 });
      expect(fetchUtil.proxyFetch).toHaveBeenCalledTimes(2);
    });

    it('should retry upstream on next call after an HTTP error', async () => {
      vi.mocked(fetchUtil.proxyFetch)
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ethereum: { usd: 1800.0 } }),
        });

      const first = await getPriceForChain(1);
      expect(first).toBeNull();

      const second = await getPriceForChain(1);
      expect(second).toMatchObject({ usd: 1800.0 });
      expect(fetchUtil.proxyFetch).toHaveBeenCalledTimes(2);
    });

    it('should use TTL cache on second call', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 2000.5 } }),
      });
      const first = await getPriceForChain(1);
      const second = await getPriceForChain(1);
      expect(first).toEqual(second);
      expect(fetchUtil.proxyFetch).toHaveBeenCalledTimes(1);
    });

    it('should reuse sibling cache for L2 chains sharing ETH coinId', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 2000.5 } }),
      });
      // Fetch Ethereum (chainId 1)
      const eth = await getPriceForChain(1);
      // Fetch Optimism (chainId 10) — same coinId 'ethereum'
      const opt = await getPriceForChain(10);
      // Should NOT have made a second network call
      expect(fetchUtil.proxyFetch).toHaveBeenCalledTimes(1);
      expect(eth.usd).toBe(opt.usd);
      expect(eth.updatedAt).toBe(opt.updatedAt);
    });
  });

  describe('getPricesForChains', () => {
    it('should batch all unique coinIds into one request', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          ethereum: { usd: 2000.5 },
          'polygon-ecosystem-token': { usd: 0.8 },
        }),
      });
      const result = await getPricesForChains([1, 137, 10]); // 10 shares ETH with 1
      expect(fetchUtil.proxyFetch).toHaveBeenCalledTimes(1);
      // Verify the URL contains both ids (not three)
      const url = vi.mocked(fetchUtil.proxyFetch).mock.calls[0][0];
      expect(url).toContain('ethereum');
      expect(url).toContain('polygon-ecosystem-token');
      expect(result.get(1)).toMatchObject({ usd: 2000.5 });
      expect(result.get(137)).toMatchObject({ usd: 0.8 });
      expect(result.get(10)).toMatchObject({ usd: 2000.5 }); // sibling reuse
    });

    it('should return null for unknown chain IDs', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      const result = await getPricesForChains([99999]);
      expect(result.get(99999)).toBeNull();
      expect(fetchUtil.proxyFetch).not.toHaveBeenCalled(); // no coinId, no fetch
    });

    it('should return null for all chains on CoinGecko failure', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockRejectedValue(new Error('timeout'));
      const result = await getPricesForChains([1, 137]);
      expect(result.get(1)).toBeNull();
      expect(result.get(137)).toBeNull();
    });

    it('should handle mixed known and unknown chains', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 2000.5 } }),
      });
      const result = await getPricesForChains([1, 99999, 137]);
      expect(result.get(1)).toMatchObject({ usd: 2000.5 });
      expect(result.get(99999)).toBeNull();
      expect(result.get(137)).toBeNull(); // no price for this one
    });

    it('should deduplicate batch requests for sibling chains', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 2000.5 } }),
      });
      // Request multiple L2s that all use ETH
      const result = await getPricesForChains([1, 10, 42161, 8453]);
      // Should only call CoinGecko once for "ethereum"
      expect(fetchUtil.proxyFetch).toHaveBeenCalledTimes(1);
      const url = vi.mocked(fetchUtil.proxyFetch).mock.calls[0][0];
      // URL should contain ids parameter with only "ethereum" once
      expect(url).toContain('ids=ethereum');
      // All chains should have the same price
      expect(result.get(1)?.usd).toBe(2000.5);
      expect(result.get(10)?.usd).toBe(2000.5);
      expect(result.get(42161)?.usd).toBe(2000.5);
      expect(result.get(8453)?.usd).toBe(2000.5);
    });

    it('should handle partial CoinGecko response gracefully', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          ethereum: { usd: 2000.5 },
          // polygon-ecosystem-token is missing
        }),
      });
      const result = await getPricesForChains([1, 137]);
      expect(result.get(1)).toMatchObject({ usd: 2000.5 });
      expect(result.get(137)).toBeNull();
    });
  });

  describe('volume, market cap and upstream freshness', () => {
    const HOUR = 3600000;
    const secs = (ms) => Math.floor(ms / 1000);

    it('asks CoinGecko for volume, market cap and its own timestamp', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true, json: async () => ({ ethereum: { usd: 2000.5 } })
      });
      await getPriceForChain(1);
      const url = vi.mocked(fetchUtil.proxyFetch).mock.calls[0][0];
      expect(url).toContain('include_24hr_vol=true');
      expect(url).toContain('include_market_cap=true');
      // Without this the response cannot be distinguished from a months-old one.
      expect(url).toContain('include_last_updated_at=true');
    });

    it('surfaces volume and market cap, and converts the timestamp to an ISO instant', async () => {
      const at = Date.now() - HOUR;
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          ethereum: {
            usd: 2000.5, usd_24h_vol: 7241466518.33,
            usd_market_cap: 226115143171.46, last_updated_at: secs(at)
          }
        })
      });
      const q = await getPriceForChain(1);
      expect(q.vol24h).toBeCloseTo(7241466518.33, 2);
      expect(q.marketCap).toBeCloseTo(226115143171.46, 2);
      expect(q.asOf).toBe(new Date(secs(at) * 1000).toISOString());
      expect(q.stale).toBe(false);
    });

    it('flags a quote whose upstream timestamp is older than the threshold', async () => {
      // Observed live: oec-token had not moved in 274 days while still being served.
      const longAgo = Date.now() - 274 * 24 * HOUR;
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 4.96, usd_24h_vol: 3700, last_updated_at: secs(longAgo) } })
      });
      const q = await getPriceForChain(1);
      expect(q.stale).toBe(true);
      // The value is still returned — the last known number and its age are useful. What
      // must not happen is a consumer showing it as current.
      expect(q.usd).toBe(4.96);
      expect(q.asOf).toBe(new Date(secs(longAgo) * 1000).toISOString());
    });

    it('treats a non-positive market cap as unknown rather than as zero', async () => {
      // Both observed live: -1 from oec-token, 0 from fantom. Neither is a market cap.
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          ethereum: { usd: 4.96, usd_market_cap: -1 },
          'polygon-ecosystem-token': { usd: 0.03, usd_market_cap: 0, usd_24h_vol: 31.66 }
        })
      });
      const m = await getPricesForChains([1, 137]);
      expect(m.get(1).marketCap).toBeNull();
      expect(m.get(137).marketCap).toBeNull();
      // Volume of 31.66 is a real reported figure for a dead market — kept, not nulled.
      expect(m.get(137).vol24h).toBeCloseTo(31.66, 2);
    });

    it('reports missing volume as null, never as zero', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true, json: async () => ({ ethereum: { usd: 2000.5 } })
      });
      const q = await getPriceForChain(1);
      expect(q.vol24h).toBeNull();
      expect(q.marketCap).toBeNull();
      expect(q.asOf).toBeNull();
      // No upstream timestamp means we cannot judge staleness, so we do not claim it is stale.
      expect(q.stale).toBe(false);
    });

    it('shares the full quote with sibling chains on the same asset', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({
        ok: true,
        json: async () => ({ ethereum: { usd: 2000.5, usd_24h_vol: 123456, last_updated_at: secs(Date.now()) } })
      });
      const m = await getPricesForChains([1, 10, 8453, 42161]);
      // Base and Arbitrum legitimately report ETH's volume — the number describes the ASSET,
      // not the chain, which is why consumers must name the asset when they show it.
      for (const id of [1, 10, 8453, 42161]) expect(m.get(id).vol24h).toBe(123456);
      expect(vi.mocked(fetchUtil.proxyFetch)).toHaveBeenCalledTimes(1);
    });

    it('still negative-caches an id upstream does not know', async () => {
      vi.mocked(fetchUtil.proxyFetch).mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await getPriceForChain(1)).toBeNull();
      await getPriceForChain(1);
      expect(vi.mocked(fetchUtil.proxyFetch)).toHaveBeenCalledTimes(1);
    });
  });
});
