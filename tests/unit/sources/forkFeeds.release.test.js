import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForkMentions, toMentions, _resetForkFeedsForTests } from '../../../src/sources/forkFeeds.js';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', () => ({ proxyFetch: vi.fn() }));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  LIVE_INCIDENTS_URL: 'https://status.test',
  FORUM_NEWS_URL: 'https://forum.test',
  WEB3_NEWS_URL: 'https://news.test',
  CLIENT_FEED_URL: 'https://clients.test',
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

describe('client release feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForkFeedsForTests();
  });

  it('reads /releases?fork=true as a fourth feed when CLIENT_FEED_URL is set', async () => {
    proxyFetch.mockImplementation(async (url) => {
      if (url.startsWith('https://clients.test/releases')) return ok('items', [release()]);
      return ok(url.startsWith('https://status.test') ? 'events' : 'news', []);
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

  it('drops repository-wide chains when the notes named no network among many', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ chainId: 42161 + i }));
    const [unnamed] = toMentions('release', release({ chains: many, chainsFrom: 'repository', enrichment: { class: 'planned_hard_fork', fork: { ...fusaka, network: null } } }));
    expect(unnamed.chains).toEqual([]);
    // A client used on one or two networks still says which one.
    const [single] = toMentions('release', release({ chains: [{ chainId: 1 }], chainsFrom: 'repository' }));
    expect(single.chains).toEqual([{ chainId: 1 }]);
  });
});
