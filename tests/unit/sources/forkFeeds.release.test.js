import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForkMentions, toMentions, _resetForkFeedsForTests } from '../../../src/sources/forkFeeds.js';
import { buildForks } from '../../../src/domain/forks.js';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', () => ({ proxyFetch: vi.fn() }));

const cfg = vi.hoisted(() => ({ clientFeedUrl: 'https://clients.test' }));
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  get CLIENT_FEED_URL() { return cfg.clientFeedUrl; },
  LIVE_INCIDENTS_URL: 'https://status.test',
  FORUM_NEWS_URL: 'https://forum.test',
  WEB3_NEWS_URL: 'https://news.test',
  LIVE_INCIDENTS_CACHE_TTL_MS: 60000
}));

const fusaka = { name: 'Fusaka', network: 'Ethereum', activationAt: '2025-12-03T21:49:11Z', activationBlock: null, state: 'scheduled' };
const release = (over = {}) => ({
  id: 'github:ethereum/go-ethereum@v1.16.7', title: 'Geth v1.16.7', url: 'https://github.com/ethereum/go-ethereum/releases/tag/v1.16.7',
  publishedAt: '2025-11-04T10:00:00Z', source: { id: 'github:ethereum/go-ethereum', name: 'go-ethereum', kind: 'client-release' },
  chains: [{ chainId: 1, name: 'Ethereum Mainnet' }], chainsFrom: 'release',
  release: { repo: 'ethereum/go-ethereum', tag: 'v1.16.7', version: '1.16.7', prerelease: false, mandatory: true },
  enrichment: { class: 'planned_hard_fork', createdAt: '2025-11-04T10:05:00Z', fork: fusaka },
  ...over
});

const ok = (key, list) => ({ ok: true, status: 200, json: async () => ({ [key]: list }) });

describe('chains the client feed\'s model chose', () => {
  it('survive normalization and place the release\'s fork', async () => {
    // As chains-client-feed 0.3.13 serves it: the model chose Sepolia from geth's networks.
    const raw = release({ enrichment: { class: 'planned_hard_fork', createdAt: '2025-11-04T10:05:00Z', fork: { ...fusaka, network: 'Ethereum Sepolia', chainIds: [11155111, 'x'] } } });
    const [mention] = toMentions('release', raw);
    expect(mention.enrichment.fork.chainIds).toEqual([11155111]);
    // By name alone, "ethereum sepolia" resolves nowhere here; the model's choice places it.
    const [out] = await buildForks([mention], { now: Date.parse('2025-11-05T00:00:00Z'), chainIdsFor: () => [] });
    expect(out.chains).toEqual([11155111]);
  });
});

describe('chains the model chose, for a release naming no network', () => {
  it('scope its fork, so mainnet and Sepolia keep their own dates', async () => {
    // geth runs many networks: the feed lists none for a release whose notes name none, and the
    // model chose mainnet. The only other Fusaka is Sepolia's, a month earlier.
    const mainnet = release({ id: 'm', url: 'https://x/m', chains: [{ chainId: 1 }, { chainId: 11155111 }, { chainId: 560048 }], chainsFrom: 'repository',
      enrichment: { class: 'planned_hard_fork', createdAt: '2025-11-04T10:05:00Z', fork: { ...fusaka, network: null, chainIds: [1] } } });
    const sepolia = release({ id: 's', url: 'https://x/s', chains: [{ chainId: 11155111 }], chainsFrom: 'fork',
      enrichment: { class: 'planned_hard_fork', createdAt: '2025-10-01T10:05:00Z', fork: { ...fusaka, network: 'Ethereum Sepolia', activationAt: '2025-10-14T07:36:00Z' } } });
    const mentions = [...toMentions('release', mainnet), ...toMentions('release', sepolia)];
    const out = await buildForks(mentions, { now: Date.parse('2025-11-05T00:00:00Z'), chainIdsFor: (s) => (s === 'ethereum sepolia' ? [11155111] : []) });
    expect(out.map(f => [f.chains, f.activationAt]).sort()).toEqual([[[1], '2025-12-03T21:49:11.000Z'], [[11155111], '2025-10-14T07:36:00.000Z']]);
  });
});

describe('client release feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForkFeedsForTests();
    cfg.clientFeedUrl = 'https://clients.test';
  });

  it('joins a base URL with a trailing slash without doubling it', async () => {
    cfg.clientFeedUrl = 'https://clients.test/';
    proxyFetch.mockImplementation(async (url) => ok(new URL(url).host === 'status.test' ? 'events' : new URL(url).host === 'clients.test' ? 'items' : 'news', []));
    await getForkMentions();
    expect(proxyFetch.mock.calls.map(([u]) => u)).toContain('https://clients.test/releases?limit=500&fork=true');
  });

  it('reads /releases?fork=true as a fourth feed when CLIENT_FEED_URL is set', async () => {
    proxyFetch.mockImplementation(async (url) => {
      if (new URL(url).host === 'clients.test') return ok('items', [release()]);
      return ok(new URL(url).host === 'status.test' ? 'events' : 'news', []);
    });
    const out = await getForkMentions();
    expect(proxyFetch.mock.calls.map(([u]) => u)).toContain('https://clients.test/releases?limit=500&fork=true');
    expect(out.feeds.release).toMatchObject({ ok: true, count: 1, filtered: true });
    const [m] = out.mentions;
    expect(m).toMatchObject({
      feed: 'release', chains: [{ chainId: 1 }],
      statusPage: { id: 'github:ethereum/go-ethereum', kind: 'release' },
      release: { repo: 'ethereum/go-ethereum', version: '1.16.7', mandatory: true },
      enrichment: { class: 'planned_hard_fork', fork: fusaka }
    });
  });

  it('keeps a monorepo release\'s component', () => {
    const [miner] = toMentions('release', release({ release: { repo: 'filecoin-project/lotus', tag: 'miner/v1.38.0', component: 'miner', version: '1.38.0', mandatory: true } }));
    expect(miner.release).toEqual({ repo: 'filecoin-project/lotus', component: 'miner', version: '1.38.0', mandatory: true });
    const [node] = toMentions('release', release({ release: { repo: 'filecoin-project/lotus', tag: 'v1.38.0', component: null, version: '1.38.0', mandatory: true } }));
    expect(node.release).not.toHaveProperty('component');
  });

  it('drops repository-wide chains when the notes named no network among many', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ chainId: 42161 + i }));
    const [unnamed] = toMentions('release', release({ chains: many, chainsFrom: 'repository', enrichment: { class: 'planned_hard_fork', fork: { ...fusaka, network: null } } }));
    expect(unnamed.chains).toEqual([]);
    // A client used on one or two networks still says which one.
    const [single] = toMentions('release', release({ chains: [{ chainId: 1 }], chainsFrom: 'repository' }));
    expect(single.chains).toEqual([{ chainId: 1 }]);
  });
});

describe('client release history', () => {
  // `n` releases, one an hour back from `from`, ids prefixed so pages can overlap on purpose.
  const page = (n, from, prefix) => Array.from({ length: n }, (_, i) => release({
    id: `${prefix}-${i}`, url: `https://r/${prefix}-${i}`,
    publishedAt: new Date(Date.parse(from) - i * 3600_000).toISOString()
  }));
  const newest = page(500, '2026-10-01T00:00:00Z', 'new');
  const oldestOfNewest = newest[499].publishedAt;
  // `until` is inclusive: the history page repeats the boundary release.
  const older = [newest[499], ...page(120, '2019-03-07T13:45:17Z', 'old')];

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForkFeedsForTests();
    cfg.clientFeedUrl = 'https://clients.test';
  });

  function serve() {
    proxyFetch.mockImplementation(async (url) => {
      const u = new URL(url);
      if (u.host !== 'clients.test') return ok(u.host === 'status.test' ? 'events' : 'news', []);
      return ok('items', u.searchParams.get('until') ? older : newest);
    });
  }

  it('pages back past the newest 500 with ?until=, one copy of each release', async () => {
    serve();
    const out = await getForkMentions();
    const historyCall = proxyFetch.mock.calls.map(([u]) => u).find((u) => u.includes('until='));
    expect(new URL(historyCall).searchParams.get('until')).toBe(oldestOfNewest);
    expect(out.feeds.release).toMatchObject({ ok: true, count: 620, oldest: older[older.length - 1].publishedAt });
    expect(new Set(out.mentions.map((m) => m.url)).size).toBe(620);
  });

  it('reads the history once an hour, not on every refresh', async () => {
    serve();
    vi.useFakeTimers({ now: Date.parse('2026-10-17T00:00:00Z'), toFake: ['Date'] });
    try {
      await getForkMentions();
      vi.setSystemTime(Date.parse('2026-10-17T00:02:00Z'));
      await getForkMentions();
      const historyCalls = proxyFetch.mock.calls.filter(([u]) => u.includes('until='));
      expect(historyCalls).toHaveLength(1);
      expect(proxyFetch.mock.calls.filter(([u]) => new URL(u).host === 'clients.test' && !u.includes('until='))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the newest page when the history read fails', async () => {
    proxyFetch.mockImplementation(async (url) => {
      const u = new URL(url);
      if (u.host !== 'clients.test') return ok(u.host === 'status.test' ? 'events' : 'news', []);
      if (u.searchParams.get('until')) return { ok: false, status: 502, json: async () => ({}) };
      return ok('items', newest);
    });
    const out = await getForkMentions();
    expect(out.feeds.release).toMatchObject({ ok: true, count: 500 });
  });

  it('does not page a feed that ignored ?fork=true', async () => {
    proxyFetch.mockImplementation(async (url) => {
      const u = new URL(url);
      if (u.host !== 'clients.test') return ok(u.host === 'status.test' ? 'events' : 'news', []);
      if (u.searchParams.get('fork')) return { ok: false, status: 400, json: async () => ({}) };
      return ok('items', newest);
    });
    await getForkMentions();
    expect(proxyFetch.mock.calls.some(([u]) => u.includes('until='))).toBe(false);
  });
});
