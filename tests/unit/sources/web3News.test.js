import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getWeb3News, _resetWeb3NewsCacheForTests } from '../../../src/sources/web3News.js';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', () => ({
  proxyFetch: vi.fn()
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  WEB3_NEWS_URL: 'https://chains-news.test',
  WEB3_NEWS_CACHE_TTL_MS: 60000,
  WEB3_NEWS_FETCH_TIMEOUT_MS: 1000
}));

function feedItem(overrides = {}) {
  return {
    title: 'Dencun ships',
    url: 'https://blog.ethereum.org/1',
    publishedAt: '2026-07-20T10:00:00.000Z',
    summary: 'The upgrade is live',
    source: { id: 'ethereum-foundation', name: 'Ethereum Foundation Blog', weight: 'primary' },
    chains: [{ chainId: 1, name: 'Ethereum Mainnet' }],
    ...overrides
  };
}

function okResponse(news) {
  return { ok: true, json: async () => ({ news }) };
}

describe('getWeb3News', () => {
  beforeEach(() => {
    _resetWeb3NewsCacheForTests();
    proxyFetch.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches, normalizes and returns news', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedItem()]));
    const result = await getWeb3News();
    expect(proxyFetch).toHaveBeenCalledWith(
      'https://chains-news.test/news?limit=200',
      expect.objectContaining({ headers: { accept: 'application/json' } })
    );
    expect(result.count).toBe(1);
    expect(result.incidents).toBeUndefined();
    expect(result.news[0]).toMatchObject({
      title: 'Dencun ships',
      source: { id: 'ethereum-foundation', weight: 'primary' },
      chains: [{ chainId: 1, name: 'Ethereum Mainnet' }]
    });
  });

  it('serves from cache within the TTL (single upstream fetch)', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedItem()]));
    await getWeb3News();
    await getWeb3News();
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedItem()]));
    await getWeb3News();
    vi.advanceTimersByTime(61000);
    await getWeb3News();
    expect(proxyFetch).toHaveBeenCalledTimes(2);
  });

  it('sorts newest first regardless of upstream order', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedItem({ title: 'older', publishedAt: '2026-01-01T00:00:00.000Z' }),
      feedItem({ title: 'newer', publishedAt: '2026-07-01T00:00:00.000Z' })
    ]));
    const result = await getWeb3News();
    expect(result.news.map((n) => n.title)).toEqual(['newer', 'older']);
  });

  it('filters by chainId, sourceId and weight', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedItem(),
      feedItem({
        title: 'Market wrap',
        source: { id: 'coindesk', name: 'CoinDesk', weight: 'secondary' },
        chains: [{ chainId: 137, name: 'Polygon' }]
      })
    ]));
    expect((await getWeb3News({ chainId: 137 })).news[0].title).toBe('Market wrap');
    expect((await getWeb3News({ sourceId: 'COINDESK' })).count).toBe(1);
    expect((await getWeb3News({ weight: 'primary' })).news[0].title).toBe('Dencun ships');
    expect((await getWeb3News({ chainId: 99999 })).count).toBe(0);
  });

  it('caps limit and reports totalMatched so a page is detectable', async () => {
    const items = Array.from({ length: 40 }, (_, i) => feedItem({ title: `Item ${i}` }));
    proxyFetch.mockResolvedValue(okResponse(items));
    const result = await getWeb3News({ limit: 5 });
    expect(result.count).toBe(5);
    expect(result.totalMatched).toBe(40);
    const capped = await getWeb3News({ limit: 9999 });
    expect(capped.count).toBe(40); // fewer than the 50 cap available
  });

  it('tolerates items with no chains or summary', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedItem({ chains: undefined, summary: null })]));
    const result = await getWeb3News();
    expect(result.news[0].chains).toEqual([]);
    expect(result.news[0].summary).toBeNull();
  });

  it('serves stale cache when a refresh fails', async () => {
    proxyFetch.mockResolvedValueOnce(okResponse([feedItem()]));
    await getWeb3News();
    vi.advanceTimersByTime(61000);
    proxyFetch.mockRejectedValueOnce(new Error('boom'));
    // News is supplementary context — a blip upstream must not fail the call.
    expect((await getWeb3News()).count).toBe(1);
  });

  it('throws when the feed is unreachable and no cache exists', async () => {
    proxyFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getWeb3News()).rejects.toThrow(/Web3 news feed unavailable/);
  });

  it('throws on non-2xx responses with no cache', async () => {
    proxyFetch.mockResolvedValue({ ok: false, status: 502 });
    await expect(getWeb3News()).rejects.toThrow(/502/);
  });
});
