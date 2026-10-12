import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForkMentions, toMention, _resetForkFeedsForTests } from '../../../src/sources/forkFeeds.js';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', () => ({ proxyFetch: vi.fn() }));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  LIVE_INCIDENTS_URL: 'https://status.test',
  FORUM_NEWS_URL: 'https://forum.test',
  WEB3_NEWS_URL: 'https://news.test',
  LIVE_INCIDENTS_CACHE_TTL_MS: 60000
}));

const glamsterdam = { name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: '2026-10-06T13:53:36Z', activationBlock: null, state: 'scheduled' };
const statusEvent = { title: 'Ethereum Sepolia Hard Fork Upgrade', statusPage: { id: 'alchemy', kind: 'rpc-provider' }, enrichment: { affectedChains: ['Ethereum Sepolia'], fork: { ...glamsterdam, name: null } } };
const forumPost = { title: 'ACDC #189', forum: { id: 'ethereum', name: 'Ethereum Magicians' }, chains: [{ chainId: 1 }], enrichment: { affectedChains: ['Ethereum'], fork: { name: 'Glamsterdam', network: 'Ethereum', activationAt: null, activationBlock: null, state: null } } };
const article = { title: 'Glamsterdam Testnet Announcement', source: { id: 'ethereum-foundation', weight: 'primary' }, enrichment: { chainNames: ['Ethereum'], fork: glamsterdam } };
const noFork = { title: 'Unrelated', source: { id: 'decrypt' }, enrichment: { class: 'market', fork: null } };

const ok = (key, list) => ({ ok: true, status: 200, json: async () => ({ [key]: list }) });

function serve(routes) {
  proxyFetch.mockImplementation(async (url) => {
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new Error(`unexpected ${url}`);
    return typeof route[1] === 'function' ? route[1](url) : route[1];
  });
}

describe('fork feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForkFeedsForTests();
  });

  it('collects fork mentions from all three feeds, asking each for forks only', async () => {
    serve([
      ['https://status.test/events', ok('events', [statusEvent])],
      ['https://forum.test/news', ok('news', [forumPost])],
      ['https://news.test/news', ok('news', [article, noFork])]
    ]);
    const out = await getForkMentions();
    expect(out.mentions.map((m) => m.feed).sort()).toEqual(['forum', 'news', 'status']);
    expect(out.feeds).toEqual({ status: { ok: true, count: 1 }, forum: { ok: true, count: 1 }, news: { ok: true, count: 1 } });
    for (const [url] of proxyFetch.mock.calls) expect(url).toContain('fork=true');
  });

  it('falls back to the unfiltered feed when a deployment rejects the fork param', async () => {
    serve([
      ['https://status.test/events', (url) => (url.includes('fork=true') ? { ok: false, status: 400 } : ok('events', [statusEvent]))],
      ['https://forum.test/news', ok('news', [])],
      ['https://news.test/news', ok('news', [])]
    ]);
    const out = await getForkMentions();
    expect(out.mentions).toHaveLength(1);
    expect(proxyFetch.mock.calls.some(([url]) => url === 'https://status.test/events?limit=500')).toBe(true);
  });

  it('keeps serving the other feeds, and says which one failed', async () => {
    serve([
      ['https://status.test/events', { ok: false, status: 503 }],
      ['https://forum.test/news', ok('news', [forumPost])],
      ['https://news.test/news', ok('news', [article])]
    ]);
    const out = await getForkMentions();
    expect(out.feeds.status).toEqual({ ok: false, count: 0 });
    expect(out.mentions).toHaveLength(2);
  });

  it('throws only when every feed is down and nothing was cached', async () => {
    serve([['https://', { ok: false, status: 503 }]]);
    await expect(getForkMentions()).rejects.toThrow(/Fork feeds unavailable/);
  });

  it('maps each feed onto the shape fork grouping reads', () => {
    const news = toMention('news', article);
    expect(news).toMatchObject({ feed: 'news', weight: 'primary', statusPage: { id: 'ethereum-foundation', kind: 'news' } });
    // chains-news calls them chainNames.
    expect(news.enrichment.affectedChains).toEqual(['Ethereum']);
    expect(news.enrichment.fork).toEqual(glamsterdam);
    expect(toMention('status', statusEvent).statusPage.kind).toBe('rpc-provider');
    expect(toMention('forum', forumPost)).toMatchObject({ feed: 'forum', chains: [{ chainId: 1 }], statusPage: { id: 'ethereum' } });
    expect(toMention('news', noFork)).toBeNull();
    // Prose is not a time, however Date.parse reads it.
    expect(toMention('news', { ...article, enrichment: { fork: { ...glamsterdam, activationAt: 'Oct 6' } } }).enrichment.fork.activationAt).toBeNull();
  });
});
