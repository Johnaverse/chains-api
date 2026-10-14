import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForkMentions, toMention, toMentions, _resetForkFeedsForTests } from '../../../src/sources/forkFeeds.js';
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
    expect(out.feeds).toEqual({
      status: { ok: true, count: 1, filtered: true, oldest: null },
      forum: { ok: true, count: 1, filtered: true, oldest: null },
      news: { ok: true, count: 1, filtered: true, oldest: null }
    });
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
    expect(out.feeds.status).toEqual({ ok: false, count: 0, filtered: false, oldest: null });
    expect(out.mentions).toHaveLength(2);
  });

  it('throws only when every feed is down and nothing was cached', async () => {
    serve([['https://', { ok: false, status: 503 }]]);
    await expect(getForkMentions()).rejects.toThrow(/Fork feeds unavailable/);
  });

  it('marks every feed failed and stale when all are down and the cache is served', async () => {
    // Review #184: the old ok:true flags came back with the stale set, so the assistant was
    // told every feed had answered during a full outage.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    serve([
      ['https://status.test/events', ok('events', [statusEvent])],
      ['https://forum.test/news', ok('news', [forumPost])],
      ['https://news.test/news', ok('news', [article])]
    ]);
    await getForkMentions();
    clock.mockReturnValue(1_000_000 + 120_000); // past the TTL
    serve([['https://', { ok: false, status: 503 }]]);
    const out = await getForkMentions();
    expect(out.feeds).toEqual({
      status: { ok: false, stale: true, count: 1, filtered: true, oldest: null },
      forum: { ok: false, stale: true, count: 1, filtered: true, oldest: null },
      news: { ok: false, stale: true, count: 1, filtered: true, oldest: null }
    });
    expect(out.mentions).toHaveLength(3);
    clock.mockRestore();
  });

  it('backs off after a full outage instead of re-fetching on every call', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    serve([['https://', ok('news', [forumPost])], ['https://status.test', ok('events', [])]]);
    await getForkMentions();
    clock.mockReturnValue(1_000_000 + 120_000);
    serve([['https://', { ok: false, status: 503 }]]);
    await getForkMentions();
    const calls = proxyFetch.mock.calls.length;
    clock.mockReturnValue(1_000_000 + 125_000); // inside the backoff
    await getForkMentions();
    expect(proxyFetch.mock.calls.length).toBe(calls);
    clock.mockRestore();
  });

  it('marks a feed that failed this round as stale when its old items are kept', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    serve([
      ['https://status.test/events', ok('events', [statusEvent])],
      ['https://forum.test/news', ok('news', [forumPost])],
      ['https://news.test/news', ok('news', [article])]
    ]);
    await getForkMentions();
    clock.mockReturnValue(1_000_000 + 120_000);
    serve([
      ['https://status.test/events', { ok: false, status: 503 }],
      ['https://forum.test/news', ok('news', [forumPost])],
      ['https://news.test/news', ok('news', [article])]
    ]);
    const out = await getForkMentions();
    expect(out.feeds.status).toEqual({ ok: false, stale: true, count: 1, filtered: true, oldest: null });
    expect(out.feeds.forum).toEqual({ ok: true, count: 1, filtered: true, oldest: null });
    clock.mockRestore();
  });

  it('shares one fetch round between concurrent callers', async () => {
    serve([
      ['https://status.test/events', ok('events', [statusEvent])],
      ['https://forum.test/news', ok('news', [forumPost])],
      ['https://news.test/news', ok('news', [article])]
    ]);
    const [a, b] = await Promise.all([getForkMentions(), getForkMentions()]);
    expect(a).toEqual(b);
    expect(proxyFetch).toHaveBeenCalledTimes(3);
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

  it('remembers a 400 to ?fork=true and reports the feed as unfiltered with its oldest item', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const page = [{ ...statusEvent, publishedAt: '2026-08-02T00:00:00Z' }, { title: 'x', publishedAt: '2026-07-01T00:00:00Z', enrichment: { fork: null } }];
    serve([
      ['https://status.test/events', (url) => (url.includes('fork=true') ? { ok: false, status: 400 } : ok('events', page))],
      ['https://forum.test/news', ok('news', [])],
      ['https://news.test/news', ok('news', [])]
    ]);
    const first = await getForkMentions();
    expect(first.feeds.status).toMatchObject({ ok: true, filtered: false, oldest: '2026-07-01T00:00:00.000Z', count: 1 });
    expect(first.feeds.forum.filtered).toBe(true);
    clock.mockReturnValue(1_000_000 + 120_000); // past the TTL, inside the 1h memory
    proxyFetch.mockClear();
    await getForkMentions();
    const statusCalls = proxyFetch.mock.calls.map(([u]) => u).filter((u) => u.startsWith('https://status.test'));
    expect(statusCalls).toEqual(['https://status.test/events?limit=500']);
    clock.mockReturnValue(1_000_000 + 2 * 60 * 60 * 1000); // memory expired: try the filter again
    proxyFetch.mockClear();
    await getForkMentions();
    expect(proxyFetch.mock.calls.some(([u]) => u.startsWith('https://status.test') && u.includes('fork=true'))).toBe(true);
    clock.mockRestore();
  });

  it('turns enrichment.forks into one mention per activation, keeping createdAt and lowConfidence', async () => {
    const a = { ...glamsterdam, name: 'Glamsterdam' };
    const b = { ...glamsterdam, name: 'Hegota' };
    const multi = { ...article, enrichment: { chainNames: ['Ethereum'], lowConfidence: true, createdAt: '2026-09-01T00:00:00Z', fork: null, forks: [a, b] } };
    const ms = toMentions('news', multi);
    expect(ms.map((m) => m.enrichment.fork.name)).toEqual(['Glamsterdam', 'Hegota']);
    expect(ms[0].enrichment).toMatchObject({ lowConfidence: true, createdAt: '2026-09-01T00:00:00Z' });
    // The primary also sits in forks[]: it is not counted twice.
    expect(toMentions('news', { ...multi, enrichment: { ...multi.enrichment, fork: a } })).toHaveLength(2);
    expect(toMention('news', multi).enrichment.fork.name).toBe('Glamsterdam');
    serve([
      ['https://status.test/events', ok('events', [])],
      ['https://forum.test/news', ok('news', [])],
      ['https://news.test/news', ok('news', [multi])]
    ]);
    expect((await getForkMentions()).mentions).toHaveLength(2);
  });
});
