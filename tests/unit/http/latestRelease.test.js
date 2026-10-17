import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', async (importOriginal) => ({
  ...(await importOriginal()),
  proxyFetch: vi.fn()
}));

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
const { parseRepo } = await import('../../../src/services/latestRelease.js');
const { handleToolCall } = await import('../../../mcp-tools.js');

const rel = (tag, over = {}, release = {}, enrichment = {}) => ({
  id: `github:ethereum/go-ethereum@${tag}`,
  title: `Geth ${tag}`,
  url: `https://github.com/ethereum/go-ethereum/releases/tag/${tag}`,
  publishedAt: '2026-10-01T00:00:00Z',
  source: { id: 'github:ethereum/go-ethereum', name: 'ethereum/go-ethereum', kind: 'client-release' },
  chains: [{ chainId: 1, name: 'Ethereum Mainnet' }],
  chainsFrom: 'repository',
  release: { repo: 'ethereum/go-ethereum', tag, version: tag.replace(/^v/, ''), component: null, prerelease: false, mandatory: false, ...release },
  enrichment: enrichment === null ? null : { class: 'routine_release', createdAt: '2026-10-01T00:05:00Z', summary: 'Fixes.', fork: null, ...enrichment },
  ...over
});

const securityRelease = rel('v1.17.8', { publishedAt: '2026-10-10T00:00:00Z' }, {
  security: true,
  securityEvidence: {
    source: 'advisory', scope: 'client', ids: ['GHSA-2gjw-fg97-vg3r'],
    advisories: [{ id: 'GHSA-2gjw-fg97-vg3r', cve: null, severity: 'high', url: 'https://github.com/ethereum/go-ethereum/security/advisories/GHSA-2gjw-fg97-vg3r', summary: 'DoS' }],
    quote: 'This is a security-focused release, fixing several DoS risk issues.'
  },
  flagsChanged: true,
  flagChanges: [{ flag: '--rpc.http-body-limit', change: 'added', quote: 'Introduce the `--rpc.http-body-limit` flag' }, { flag: '--x', change: 'bogus', quote: 'x' }],
  flagChangesCarriedOver: 1
}, { class: 'urgent_software_fix' });

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const page = (items) => json({ totalMatched: items.length, count: items.length, truncated: false, items });

let app;
beforeAll(async () => { app = await buildApp({ logger: false, loadDataOnStartup: false }); });
afterAll(async () => { await app.close(); });
beforeEach(() => {
  cfg.url = 'http://client-feed.test/';
  proxyFetch.mockReset();
  _resetClientFeedCacheForTests();
});

const get = (url) => app.inject({ method: 'GET', url });

describe('parseRepo', () => {
  it.each([
    ['ethereum/go-ethereum', 'github:ethereum/go-ethereum'],
    ['GitHub:Ethereum/Go-Ethereum', 'github:ethereum/go-ethereum'],
    ['gitlab:o/r', 'gitlab:o/r'],
    ['https://github.com/ethereum/go-ethereum', 'github:ethereum/go-ethereum'],
    ['github.com/sigp/lighthouse/releases/tag/v8.0.0', 'github:sigp/lighthouse'],
    ['https://gitlab.com/o/r.git', 'gitlab:o/r']
  ])('%s -> %s', (input, out) => {
    expect(parseRepo(input)).toBe(out);
  });

  it.each(['', 'geth', 'a/b/c', '../x', 'https://example.com/o/r', '../..', null])('rejects %s', (input) => {
    expect(parseRepo(input)).toBeNull();
  });
});

describe('GET /client-releases/latest', () => {
  it('answers the latest stable release with hardfork, mandatory, security, flags and link', async () => {
    proxyFetch.mockResolvedValue(page([
      rel('v1.18.0-rc1', { publishedAt: '2026-10-12T00:00:00Z' }, { prerelease: true }),
      securityRelease,
      rel('v1.17.7', { publishedAt: '2026-09-01T00:00:00Z' })
    ]));
    const res = await get('/client-releases/latest?repo=https://github.com/ethereum/go-ethereum');
    expect(res.statusCode).toBe(200);
    const [url] = proxyFetch.mock.calls[0];
    expect(url).toBe('http://client-feed.test/releases?limit=100&repo=github%3Aethereum%2Fgo-ethereum');
    const body = res.json();
    expect(body).toMatchObject({
      repo: 'github:ethereum/go-ethereum',
      latest: {
        version: '1.17.8',
        tag: 'v1.17.8',
        url: 'https://github.com/ethereum/go-ethereum/releases/tag/v1.17.8',
        prerelease: false,
        hardfork: { included: false, forks: [] },
        mandatory: false,
        security: { update: true, source: 'advisory', scope: 'client', ids: ['GHSA-2gjw-fg97-vg3r'] },
        flags: { changed: true, carriedOver: 1, changes: [{ flag: '--rpc.http-body-limit', change: 'added' }] },
        class: 'urgent_software_fix'
      },
      newerPrerelease: { version: '1.18.0-rc1', tag: 'v1.18.0-rc1' }
    });
    // An unknown change kind from the feed is dropped, not passed on.
    expect(body.latest.flags.changes).toHaveLength(1);
    expect(body.latest.security.advisories[0].severity).toBe('high');
    expect(body).not.toHaveProperty('components');
  });

  it('reports a scheduled fork as included and lists it', async () => {
    const fork = { name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: null, activationBlock: null, state: 'scheduled', activationTimestamp: 1791000000 };
    proxyFetch.mockResolvedValue(page([rel('v1.18.0', {}, { mandatory: true }, { class: 'planned_hard_fork', fork })]));
    const latest = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest;
    expect(latest.hardfork).toEqual({ included: true, forks: [{ name: 'Glamsterdam', network: 'Ethereum Sepolia', state: 'scheduled', activationAt: null, activationBlock: null, activationTimestamp: 1791000000 }] });
    expect(latest.mandatory).toBe(true);
  });

  it('answers null, not false, for what the feed cannot say', async () => {
    proxyFetch.mockResolvedValue(page([rel('v1.17.9', {}, {}, null)]));
    const latest = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest;
    expect(latest.hardfork.included).toBeNull();
    expect(latest.mandatory).toBeNull();
    expect(latest.security).toMatchObject({ update: null, source: null });
    expect(latest.flags).toEqual({ changed: null, changes: [], carriedOver: null });
  });

  it('lists each component of a monorepo, and filters by one', async () => {
    const opRel = (component, tag, publishedAt) => rel(`${component}/${tag}`, { publishedAt }, { component, version: tag.slice(1) });
    proxyFetch.mockResolvedValue(page([
      opRel('op-reth', 'v2.6.0', '2026-10-09T00:00:00Z'),
      opRel('op-node', 'v1.16.0', '2026-10-08T00:00:00Z'),
      opRel('op-reth', 'v2.5.0', '2026-09-09T00:00:00Z')
    ]));
    const all = (await get('/client-releases/latest?repo=ethereum-optimism/optimism')).json();
    expect(all.latest.tag).toBe('op-reth/v2.6.0');
    expect(all.components.map((c) => c.component)).toEqual(['op-reth', 'op-node']);
    const node = (await get('/client-releases/latest?repo=ethereum-optimism/optimism&component=OP-NODE')).json();
    expect(node.latest.tag).toBe('op-node/v1.16.0');
    expect(node).not.toHaveProperty('components');
  });

  it('says when only prereleases exist, and returns one on request', async () => {
    proxyFetch.mockResolvedValue(page([rel('v0.1.0-rc1', {}, { prerelease: true })]));
    const stable = (await get('/client-releases/latest?repo=o/r')).json();
    expect(stable.latest).toBeNull();
    expect(stable.note).toMatch(/Only prereleases/);
    const pre = (await get('/client-releases/latest?repo=o/r&prerelease=true')).json();
    expect(pre.latest.tag).toBe('v0.1.0-rc1');
    expect(pre.newerPrerelease).toBeNull();
  });

  it('404s for a repo with no releases, 400s for a malformed repo or a stray param', async () => {
    proxyFetch.mockResolvedValue(page([]));
    expect((await get('/client-releases/latest?repo=o/none')).statusCode).toBe(404);
    expect((await get('/client-releases/latest?repo=geth')).statusCode).toBe(400);
    expect((await get('/client-releases/latest')).statusCode).toBe(400);
    expect((await get('/client-releases/latest?repo=o/r&chainId=1')).statusCode).toBe(400);
    expect((await get('/client-releases/latest?repo=o/r&component=a%20b')).statusCode).toBe(400);
  });

  it('503s when the feed is not configured', async () => {
    cfg.url = '';
    expect((await get('/client-releases/latest?repo=o/r')).statusCode).toBe(503);
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});

describe('get_latest_release (MCP)', () => {
  const parse = (r) => JSON.parse(r.content[0].text);

  it('returns the same answer, with chains capped', async () => {
    const chains = Array.from({ length: 14 }, (_, i) => ({ chainId: i + 1, name: `Chain ${i + 1}` }));
    proxyFetch.mockResolvedValue(page([{ ...securityRelease, chains }]));
    const out = parse(await handleToolCall('get_latest_release', { repo: 'ethereum/go-ethereum' }));
    expect(out.latest).toMatchObject({ version: '1.17.8', security: { update: true }, flags: { changed: true }, chainsTotal: 14 });
    expect(out.latest.chains).toHaveLength(10);
  });

  it('errors plainly on a bad repo, an unknown repo and a feed outage', async () => {
    const bad = await handleToolCall('get_latest_release', { repo: 'geth' });
    expect(bad.isError).toBe(true);
    proxyFetch.mockResolvedValue(page([]));
    expect(parse(await handleToolCall('get_latest_release', { repo: 'o/none' })).error).toBe('No releases found');
    _resetClientFeedCacheForTests();
    proxyFetch.mockRejectedValue(new Error('down'));
    expect(parse(await handleToolCall('get_latest_release', { repo: 'o/r' })).error).toBe('Client release feed unavailable');
  });

  it('get_client_releases carries security and flagsChanged per release', async () => {
    proxyFetch.mockResolvedValue(page([securityRelease]));
    const out = parse(await handleToolCall('get_client_releases', { repo: 'ethereum/go-ethereum' }));
    expect(out.releases[0]).toMatchObject({ security: true, flagsChanged: true });
  });
});
