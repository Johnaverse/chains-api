import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', async (importOriginal) => ({
  ...(await importOriginal()),
  proxyFetch: vi.fn()
}));

// Mutable so one file can cover configured and unconfigured.
const cfg = vi.hoisted(() => ({ url: 'http://client-feed.test/' }));
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get CLIENT_FEED_URL() { return cfg.url; },
    CLIENT_FEED_CACHE_TTL_MS: 60000
  };
});

const { buildApp } = await import('../../../index.js');
const { _resetClientFeedCacheForTests } = await import('../../../src/sources/clientFeed.js');

const fusaka = { name: 'Fusaka', network: 'Ethereum', activationAt: '2025-12-03T21:49:11Z', activationBlock: null, state: 'scheduled', activationEpoch: 411392 };
const release = {
  id: 'github:ethereum/go-ethereum@v1.16.7', title: 'Geth v1.16.7', url: 'https://github.com/ethereum/go-ethereum/releases/tag/v1.16.7',
  publishedAt: '2025-11-04T10:00:00Z', source: { id: 'github:ethereum/go-ethereum', name: 'go-ethereum', kind: 'client-release' },
  chains: [{ chainId: 1, name: 'Ethereum Mainnet' }], chainsFrom: 'release',
  release: { repo: 'ethereum/go-ethereum', tag: 'v1.16.7', version: '1.16.7', prerelease: false, mandatory: true },
  enrichment: { class: 'planned_hard_fork', createdAt: '2025-11-04T10:05:00Z', summary: 'Fusaka mainnet release', fork: fusaka }
};
const geth = {
  id: 'github:ethereum/go-ethereum', host: 'github.com', repo: 'ethereum/go-ethereum', url: 'https://github.com/ethereum/go-ethereum',
  kinds: ['execution'], names: ['Geth'],
  networks: [{ chainId: 1, name: 'Ethereum Mainnet', kinds: ['execution'], source: 'research' }, { chainId: 11155111, name: 'Sepolia', kinds: ['execution'], source: 'research' }],
  latestRelease: { tag: 'v1.16.7', version: '1.16.7', publishedAt: '2025-11-04T10:00:00Z', url: release.url },
  latestFork: fusaka
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

let app;
beforeAll(async () => {
  app = await buildApp({ logger: false, loadDataOnStartup: false });
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  cfg.url = 'http://client-feed.test/';
  proxyFetch.mockReset();
  _resetClientFeedCacheForTests();
});

const get = (url) => app.inject({ method: 'GET', url });

describe('GET /client-releases', () => {
  it('503s without touching the network when CLIENT_FEED_URL is unset', async () => {
    cfg.url = '';
    for (const url of ['/client-releases', '/client-releases/clients', '/client-releases/clients/github/a/b', '/client-releases/networks/1']) {
      const res = await get(url);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'Client release feed not configured' });
    }
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('passes filters through and normalizes items', async () => {
    proxyFetch.mockResolvedValue(json({ items: [release, { id: 'x', release: null }] }));
    const res = await get('/client-releases?limit=200&fork=true&chainId=1&repo=ethereum/go-ethereum&since=2025-01-01');
    expect(res.statusCode).toBe(200);
    const url = new URL(proxyFetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('http://client-feed.test/releases');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '200', fork: 'true', chainId: '1', repo: 'github:ethereum/go-ethereum', since: '2025-01-01'
    });
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.items[0]).toMatchObject({
      release: { version: '1.16.7', mandatory: true, prerelease: false },
      enrichment: { fork: { name: 'Fusaka', activationEpoch: 411392 }, summary: 'Fusaka mainnet release' }
    });
    // Missing fields are tolerated, not crashed on.
    expect(body.items[1]).toMatchObject({ id: 'x', chains: [], enrichment: null, release: { tag: null, prerelease: false } });
  });

  it('serves the cache inside the TTL', async () => {
    proxyFetch.mockResolvedValue(json({ items: [release] }));
    await get('/client-releases?limit=5');
    await get('/client-releases?limit=5');
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('502s on upstream failure with no cache, and serves stale after one', async () => {
    proxyFetch.mockResolvedValue(json({ error: 'boom' }, 500));
    const res = await get('/client-releases');
    expect(res.statusCode).toBe(502);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      proxyFetch.mockResolvedValueOnce(json({ items: [release] }));
      expect((await get('/client-releases?limit=7')).statusCode).toBe(200);
      vi.setSystemTime(Date.now() + 120000);
      proxyFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const stale = await get('/client-releases?limit=7');
      expect(stale.statusCode).toBe(200);
      expect(stale.json()).toMatchObject({ stale: true, count: 1 });
    } finally { vi.useRealTimers(); }
  });

  it('rejects bad query params with 400', async () => {
    for (const q of ['limit=501', 'limit=0', 'fork=maybe', 'chainId=abc', 'repo=../../etc', 'repo=../x', 'repo=a/..', 'repo=a/b?x=1', 'since=yesterday', 'bogus=1']) {
      expect((await get(`/client-releases?${q}`)).statusCode, q).toBe(400);
    }
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});

describe('GET /client-releases/clients', () => {
  it('passes q/kind/chainId through and slims entries', async () => {
    proxyFetch.mockResolvedValue(json({ clients: [geth] }));
    const res = await get('/client-releases/clients?q=geth&kind=execution&chainId=1');
    expect(res.statusCode).toBe(200);
    const url = new URL(proxyFetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/clients');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'geth', kind: 'execution', chainId: '1', limit: '100' });
    const [c] = res.json().clients;
    expect(c).toMatchObject({ id: 'github:ethereum/go-ethereum', networkCount: 2, latestFork: { name: 'Fusaka' } });
    expect(c.networks).toBeUndefined();
  });

  it('relays an upstream 400 (unknown kind) as 400', async () => {
    proxyFetch.mockResolvedValue(json({ error: 'invalid_query', message: 'querystring/kind must be equal to one of the allowed values' }, 400));
    const res = await get('/client-releases/clients?kind=nope');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/kind/);
  });

  it('passes the review flag through, bounded', async () => {
    const review = { reasons: ['notes mention a network upgrade the model did not confirm'], quotes: ['QIE Mainnet — Network Upgrade Release'], extra: 1 };
    proxyFetch.mockResolvedValue(json({ totalMatched: 1, count: 1, truncated: false, items: [{ ...release, enrichment: { ...release.enrichment, fork: null, review } }] }));
    const item = (await get('/client-releases?limit=1')).json().items[0];
    expect(item.enrichment.review).toEqual({ reasons: review.reasons, quotes: review.quotes });
  });

  it('passes until through and rejects a malformed one', async () => {
    proxyFetch.mockResolvedValue(json({ totalMatched: 0, count: 0, truncated: false, items: [] }));
    expect((await get('/client-releases?since=2026-09-01&until=2026-09-30')).statusCode).toBe(200);
    expect(Object.fromEntries(new URL(proxyFetch.mock.calls[0][0]).searchParams)).toMatchObject({ since: '2026-09-01', until: '2026-09-30' });
    expect((await get('/client-releases?until=yesterday')).statusCode).toBe(400);
  });

  it('carries the full activity on one client and the compact one on list rows', async () => {
    const full = {
      refreshedAt: '2026-10-15T00:00:00Z', source: 'github', archived: false, pushedAt: '2026-10-14T00:00:00Z', stars: 9,
      commits: { days30: 40, days90: 120, branch: 'master' }, mergedPullRequests: { days30: 30, days90: 90, atLeast: false }, openPullRequests: 5,
      issues: { open: 211, openedDays30: 42, openedAtLeast: false, bug: 65, critical: 2, criticalLabels: [{ name: 'C-security', open: 2 }], countsExact: true },
      advisories: { total: 1, last365Days: 1, bySeverity: { high: 1 }, latest: [{ id: 'GHSA-x', severity: 'high', publishedAt: '2026-10-10T00:00:00Z', summary: 's', url: 'u', extra: 'dropped' }] },
      level: 'active', attention: { level: 'high', reasons: ['r'] }, junk: 1
    };
    proxyFetch.mockResolvedValue(json({ client: { ...geth, role: 'client' }, activity: full, poll: { status: 'ok' } }));
    const one = (await get('/client-releases/clients/github/ethereum/go-ethereum')).json().client;
    expect(one.role).toBe('client');
    expect(one.activity).toMatchObject({ level: 'active', issues: { bug: 65, critical: 2, criticalLabels: [{ name: 'C-security', open: 2 }] }, attention: { level: 'high', reasons: ['r'] } });
    expect(one.activity.advisories.bySeverity).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    expect(one.activity.advisories.latest[0]).not.toHaveProperty('extra');
    expect(one.activity).not.toHaveProperty('junk');

    _resetClientFeedCacheForTests();
    proxyFetch.mockResolvedValue(json({ totalMatched: 1, count: 1, truncated: false, clients: [{ ...geth, activity: { level: 'active', attention: 'high', commits30: 40, merged30: 30, openIssues: 211, criticalIssues: 2, advisories365: 1, refreshedAt: '2026-10-15T00:00:00Z' } }] }));
    const row = (await get('/client-releases/clients?q=geth')).json().clients[0];
    expect(row.activity).toEqual({ level: 'active', attention: 'high', commits30: 40, merged30: 30, merged30AtLeast: false, openIssues: 211, criticalIssues: 2, advisories365: 1, refreshedAt: '2026-10-15T00:00:00Z' });
    _resetClientFeedCacheForTests();
    proxyFetch.mockResolvedValue(json({ clients: [geth] }));
    expect((await get('/client-releases/clients?q=geth')).json().clients[0].activity).toBeNull();
  });

  it('rejects query parameters on the lookup routes', async () => {
    expect((await get('/client-releases/clients/github/ethereum/go-ethereum?chainId=1')).statusCode).toBe(400);
    expect((await get('/client-releases/networks/1?kind=consensus')).statusCode).toBe(400);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('passes the feed totals through, and leaves them unknown for a legacy bare list', async () => {
    proxyFetch.mockResolvedValue(json({ totalMatched: 42, count: 1, truncated: true, clients: [geth] }));
    expect((await get('/client-releases/clients?q=geth')).json()).toMatchObject({ totalMatched: 42, truncated: true, count: 1 });
    _resetClientFeedCacheForTests();
    proxyFetch.mockResolvedValue(json([geth]));
    expect((await get('/client-releases/clients?q=geth')).json()).toMatchObject({ totalMatched: null, truncated: null, count: 1 });
  });

  it('rejects a malformed kind', async () => {
    expect((await get('/client-releases/clients?kind=EXEC%20UTION')).statusCode).toBe(400);
  });
});

describe('GET /client-releases/clients/:host/:owner/:repo', () => {
  it('returns the entry with its networks', async () => {
    proxyFetch.mockResolvedValue(json(geth));
    const res = await get('/client-releases/clients/github/ethereum/go-ethereum');
    expect(res.statusCode).toBe(200);
    expect(proxyFetch.mock.calls[0][0]).toBe('http://client-feed.test/clients/github/ethereum/go-ethereum');
    expect(res.json().client.networks.map(n => n.chainId)).toEqual([1, 11155111]);
  });

  it('reads the feed envelope {client, poll, latestRelease, latestFork}', async () => {
    const { latestRelease: _r, latestFork: _f, ...entry } = geth;
    proxyFetch.mockResolvedValue(json({ client: entry, poll: { status: 'ok' }, latestRelease: release, latestFork: release }));
    const { client } = (await get('/client-releases/clients/github/ethereum/go-ethereum')).json();
    expect(client).toMatchObject({
      pollStatus: 'ok', networkCount: 2,
      latestRelease: { version: '1.16.7', publishedAt: '2025-11-04T10:00:00Z', mandatory: true, url: release.url },
      latestFork: { name: 'Fusaka', activationEpoch: 411392 }
    });
  });

  it('maps an upstream 404 to 404', async () => {
    proxyFetch.mockResolvedValue(json({ error: 'nope' }, 404));
    const res = await get('/client-releases/clients/gitlab/a/b');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Client not found' });
  });

  it('validates path params strictly', async () => {
    for (const p of ['bitbucket/a/b', 'github/..%2F..%2Fx/b', 'github/a/..', 'github/a/b%20c', 'github/a%3Fx/b', 'github/.../b']) {
      const res = await get(`/client-releases/clients/${p}`);
      expect([400, 404], p).toContain(res.statusCode);
    }
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});

describe('GET /client-releases/networks/:chainId', () => {
  it('accepts {entry, network} pairs and takes per-chain kinds', async () => {
    proxyFetch.mockResolvedValue(json({ clients: [{ entry: { ...geth, kinds: ['execution', 'node'] }, network: { chainId: 1, kinds: ['execution'], source: 'research' } }] }));
    const res = await get('/client-releases/networks/1');
    expect(res.statusCode).toBe(200);
    expect(proxyFetch.mock.calls[0][0]).toBe('http://client-feed.test/networks/1/clients');
    expect(res.json()).toMatchObject({ chainId: 1, count: 1, clients: [{ repo: 'ethereum/go-ethereum', kinds: ['execution'], networkCount: 2 }] });
  });

  it('reads the feed rows (per-chain kinds, latestVersion/latestTag)', async () => {
    proxyFetch.mockResolvedValue(json({ chainId: 1, name: 'Ethereum Mainnet', clients: [{
      id: geth.id, host: 'github.com', repo: geth.repo, url: geth.url, supported: true, names: ['Geth'],
      kinds: ['execution'], source: 'research', latestVersion: '1.16.7', latestTag: 'v1.16.7', pollStatus: 'ok'
    }] }));
    const body = (await get('/client-releases/networks/1')).json();
    // Flattened row: its source is on the entry, not a nested network.
    expect(body.clients[0].source).toBe('research');
    expect(body).toMatchObject({ name: 'Ethereum Mainnet', clients: [{ latestRelease: { version: '1.16.7', tag: 'v1.16.7' }, networkCount: null, latestFork: null, pollStatus: 'ok' }] });
  });

  it('accepts flattened entries', async () => {
    proxyFetch.mockResolvedValue(json([geth]));
    const res = await get('/client-releases/networks/11155111');
    expect(res.json().clients[0]).toMatchObject({ kinds: ['execution'], source: 'research' });
  });

  it('treats an upstream 404 as no clients, and rejects a non-integer id', async () => {
    proxyFetch.mockResolvedValue(json({}, 404));
    expect((await get('/client-releases/networks/999999')).json()).toMatchObject({ count: 0, clients: [] });
    expect((await get('/client-releases/networks/abc')).statusCode).toBe(400);
    expect((await get('/client-releases/networks/-1')).statusCode).toBe(400);
  });
});
