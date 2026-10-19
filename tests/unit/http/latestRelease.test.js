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

const registry = vi.hoisted(() => ({ chains: null }));
vi.mock('../../../src/store/queries.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { TESTNET_REGISTRY } = await import('../../fixtures/testnetRegistry.js');
  return {
    ...actual,
    searchChains: (q) => registry.chains ?? actual.searchChains(q),
    // The registry is what says which chains and words are test networks.
    getAllChains: () => TESTNET_REGISTRY,
    getChainById: (id) => TESTNET_REGISTRY.find((c) => c.chainId === Number(id)) ?? actual.getChainById(id)
  };
});

const known = vi.hoisted(() => ({ forks: null }));
vi.mock('../../../src/services/forks.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { learnForkNames } = await import('../../../src/domain/forkNames.js');
  // Building the fork list is what teaches which names are one fork; the stub does the same.
  return {
    ...actual,
    getAllForks: () => {
      if (!known.forks) return actual.getAllForks();
      learnForkNames(known.forks);
      return Promise.resolve({ forks: known.forks });
    }
  };
});

// What the feeds showed: Hoodi's activation reported as Glamsterdam, Gloas and Amsterdam.
const HOODI_GLAMSTERDAM = { name: 'Glamsterdam', aliases: ['Gloas', 'Amsterdam'], chains: [560048], phase: 'upcoming', events: [{}, {}, {}] };

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
  registry.chains = null;
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
    ['https://gitlab.com/o/r.git', 'gitlab:o/r'],
    ['https://gitlab.com/o/r/-/releases', 'gitlab:o/r'],
    ['o/r.git', 'github:o/r'],
    ['https://gitlab.com/o/r//', 'gitlab:o/r']
  ])('%s -> %s', (input, out) => {
    expect(parseRepo(input)).toBe(out);
  });

  it.each(['', 'geth', 'a/b/c', '../x', 'https://example.com/o/r', '../..', null, 'https://gitlab.com/group/sub/repo', 'github.com/ethereum', 'example.com/o', `github.com/${'/'.repeat(5000)}x`, `${'x'.repeat(301)}/r`])('rejects %s', (input) => {
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
    expect(latest.hardfork).toEqual({ included: true, forks: [{ name: 'Glamsterdam', network: 'Ethereum Sepolia', state: 'scheduled', phase: 'past', activationAt: null, activationBlock: null, activationTimestamp: 1791000000 }] });
    expect(latest.mandatory).toBe(true);
  });

  it('does not take an undated "completed" as past when the fork list has it ahead', async () => {
    // geth v1.17.8: "fixes related to the already-active Amsterdam fork", a week before Hoodi.
    const forks = [
      { name: 'Amsterdam', network: null, activationAt: null, activationBlock: null, state: 'completed' },
      { name: 'Zanzibar', network: 'IoTeX', activationAt: null, state: 'completed' }
    ];
    known.forks = [
      { name: 'Glamsterdam', aliases: ['Gloas', 'Amsterdam'], chains: [1], phase: 'unscheduled', events: [{}, {}] },
      { name: 'Glamsterdam', chains: [560048], phase: 'upcoming' },
      { name: 'Zanzibar', chains: [4689], phase: 'past' }
    ];
    try {
      proxyFetch.mockResolvedValue(page([rel('v1.17.8', { chains: [{ chainId: 1 }, { chainId: 560048 }] }, {}, { class: 'urgent_software_fix', forks })]));
      const { forks: out } = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest.hardfork;
      expect(out.map((f) => [f.name, f.state, f.phase, f.phaseFrom ?? null])).toEqual([
        ['Glamsterdam', 'completed', 'upcoming', 'forks'],
        // No fork-list entry on the release's chains: the notes' word stands.
        ['Zanzibar', 'completed', 'past', null]
      ]);
    } finally {
      known.forks = null;
    }
  });

  it('gives each fork its phase now, whatever state the notes gave', async () => {
    const forks = [
      { name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: '2026-10-06T13:53:36.000Z', state: 'scheduled' },
      { name: 'Jenner', network: 'BSC Chapel testnet', activationAt: '2099-10-29T02:30:00.000Z', state: 'scheduled' },
      { name: 'Denim', network: 'Base Sepolia', activationAt: new Date().toISOString().slice(0, 10), state: 'scheduled' },
      { name: 'Rex6', network: 'MegaETH Mainnet', activationAt: null, state: 'scheduled' },
      { name: 'Zanzibar', network: 'IoTeX', activationAt: null, state: 'completed' },
      { name: 'Fortuna', network: 'Metal', activationAt: '2099-01-01T00:00:00.000Z', state: 'cancelled' }
    ];
    proxyFetch.mockResolvedValue(page([rel('v2.7.0', {}, {}, { class: 'planned_hard_fork', forks })]));
    const { forks: out } = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest.hardfork;
    expect(out.map((f) => [f.name, f.state, f.phase])).toEqual([
      ['Glamsterdam', 'scheduled', 'past'],
      ['Jenner', 'scheduled', 'upcoming'],
      // A date-only activation is upcoming until that UTC day ends.
      ['Denim', 'scheduled', 'upcoming'],
      ['Rex6', 'scheduled', 'unscheduled'],
      ['Zanzibar', 'completed', 'past'],
      ['Fortuna', 'cancelled', 'cancelled']
    ]);
  });

  it('lists one fork per activation, under its combined Ethereum name and the release chain', async () => {
    const forks = [
      { name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: '2026-10-06T13:53:36.000Z', state: 'scheduled' },
      { name: 'Amsterdam', network: 'Ethereum Sepolia', activationAt: null, state: 'scheduled' },
      { name: 'Gloas', network: 'Hoodi', activationAt: null, state: 'scheduled' },
      { name: 'Jenner', network: 'BSC Chapel testnet', activationAt: null, state: 'scheduled' }
    ];
    const chains = [{ chainId: 11155111, name: 'Ethereum Sepolia' }, { chainId: 560048, name: 'Ethereum Hoodi' }];
    known.forks = [HOODI_GLAMSTERDAM];
    try {
      proxyFetch.mockResolvedValue(page([rel('v2.7.0', { chains }, { mandatory: true }, { class: 'planned_hard_fork', forks })]));
      const { forks: out } = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest.hardfork;
      expect(out.map((f) => [f.name, f.layerName ?? null, f.network, f.chainId ?? null, f.activationAt])).toEqual([
        ['Glamsterdam', null, 'Ethereum Sepolia', 11155111, '2026-10-06T13:53:36.000Z'],
        ['Glamsterdam', 'Gloas', 'Ethereum Hoodi', 560048, null],
        ['Jenner', null, 'BSC Chapel testnet', null, null]
      ]);
    } finally {
      known.forks = null;
    }
  });

  it('names a fork network the release chains leave out from the registry, Ethereum first for a bare testnet name', async () => {
    registry.chains = [{ chainId: 374, name: 'Status Network Hoodi' }, { chainId: 560048, name: 'Ethereum Hoodi' }, { chainId: 2910, name: 'Morph Hoodi' }];
    const forks = [{ name: 'Gloas', network: 'Hoodi', activationAt: '2026-10-26T17:42:48.000Z', state: 'scheduled' }];
    known.forks = [HOODI_GLAMSTERDAM];
    try {
      proxyFetch.mockResolvedValue(page([rel('v7.3.0', { chains: [{ chainId: 17000, name: 'Holesky' }] }, { mandatory: true }, { class: 'planned_hard_fork', forks })]));
      const [fork] = (await get('/client-releases/latest?repo=OffchainLabs/prysm')).json().latest.hardfork.forks;
      expect(fork).toMatchObject({ name: 'Glamsterdam', layerName: 'Gloas', network: 'Ethereum Hoodi', chainId: 560048 });
    } finally {
      known.forks = null;
    }
  });

  it('keeps another network\'s Sepolia and a bare "Mainnet" on the right chain', async () => {
    const chains = [{ chainId: 1, name: 'Ethereum Mainnet' }, { chainId: 11155111, name: 'Sepolia' }, { chainId: 560048, name: 'Ethereum Hoodi' }];
    const forks = [
      { name: 'Jovian', network: 'Base Sepolia', state: 'scheduled' },
      { name: 'Glamsterdam', network: 'Mainnet', state: 'Scheduled' },
      { name: 'Glamsterdam', network: 'Ethereum Mainnet', activationAt: '2027-01-01T00:00:00.000Z', state: 'scheduled' }
    ];
    proxyFetch.mockResolvedValue(page([rel('v1.18.0', { chains }, {}, { class: 'routine_release', forks })]));
    const { hardfork } = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest;
    expect(hardfork.included).toBe(true);
    expect(hardfork.forks.map((f) => [f.name, f.network, f.chainId ?? null, f.state, f.activationAt])).toEqual([
      ['Jovian', 'Base Sepolia', null, 'scheduled', null],
      ['Glamsterdam', 'Ethereum Mainnet', 1, 'scheduled', '2027-01-01T00:00:00.000Z']
    ]);
  });

  it('reads an enrichment without a class as unknown, and keeps a stated mandatory', async () => {
    proxyFetch.mockResolvedValue(page([rel('v1.17.9', {}, { mandatory: true }, { class: null, review: { fork: 'possible' } })]));
    const latest = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json().latest;
    expect(latest.hardfork.included).toBeNull();
    expect(latest.mandatory).toBe(true);
  });

  it('reads past the first page for a component or a stable release behind it', async () => {
    const rcs = Array.from({ length: 100 }, (_, i) => rel(`v2.0.0-rc${100 - i}`, {}, { prerelease: true }));
    proxyFetch
      .mockResolvedValueOnce(json({ totalMatched: 101, count: 100, truncated: true, items: rcs }))
      .mockResolvedValueOnce(page([...rcs, rel('v1.9.0', { publishedAt: '2026-01-01T00:00:00Z' })]));
    const out = (await get('/client-releases/latest?repo=ethereum/go-ethereum')).json();
    expect(proxyFetch.mock.calls[1][0]).toContain('limit=500');
    expect(out.latest.version).toBe('1.9.0');
    expect(out.newerPrerelease.version).toBe('2.0.0-rc100');
  });

  it('names a newer prerelease of the same component only', async () => {
    const opRel = (component, tag, pre, publishedAt) => rel(`${component}/${tag}`, { publishedAt }, { component, version: tag.slice(1), prerelease: pre });
    proxyFetch.mockResolvedValue(page([
      opRel('op-batcher', 'v1.18.0-rc.1', true, '2026-10-10T00:00:00Z'),
      opRel('op-node', 'v1.16.0', false, '2026-10-08T00:00:00Z')
    ]));
    const out = (await get('/client-releases/latest?repo=ethereum-optimism/optimism')).json();
    expect(out.latest.tag).toBe('op-node/v1.16.0');
    expect(out.newerPrerelease).toBeNull();
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
    expect(stable.note).toMatch(/Only prereleases.*prerelease=true/);
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

  it('looks on GitLab for a bare owner/repo GitHub has no releases of, never for a stated host', async () => {
    proxyFetch.mockImplementation(async (url) => (String(url).includes('gitlab%3Atezos') || String(url).includes('gitlab:tezos')
      ? page([rel('octez-evm-node-v0.67', { source: { id: 'gitlab:tezos/tezos' } })])
      : page([])));
    const body = (await get('/client-releases/latest?repo=tezos/tezos')).json();
    expect(body).toMatchObject({ repo: 'gitlab:tezos/tezos', latest: { tag: 'octez-evm-node-v0.67' } });
    expect((await get('/client-releases/latest?repo=github:tezos/tezos')).statusCode).toBe(404);
    expect((await get('/client-releases/latest?repo=https://github.com/tezos/tezos')).statusCode).toBe(404);
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

  it('drops feed evidence that contradicts or overruns the answer', async () => {
    const odd = rel('v1.17.9', {}, {
      security: false,
      securityEvidence: securityRelease.release.securityEvidence,
      flagsChanged: true,
      flagChanges: [{ flag: 'x'.repeat(500), change: 'added', quote: 'q' }, { flag: null, change: 'removed', quote: 'flags removed' }],
      flagChangesCarriedOver: -3
    });
    const bad = rel('v1.17.8', {}, { ...securityRelease.release, securityEvidence: { ...securityRelease.release.securityEvidence, advisories: [{ id: 'GHSA-x', url: 'javascript:alert(1)' }] } });
    proxyFetch.mockResolvedValue(page([odd]));
    const a = parse(await handleToolCall('get_latest_release', { repo: 'ethereum/go-ethereum' })).latest;
    expect(a.security).toMatchObject({ update: false, source: null });
    expect(a.flags).toEqual({ changed: true, changes: [{ flag: null, change: 'removed', quote: 'flags removed' }], carriedOver: null });
    _resetClientFeedCacheForTests();
    proxyFetch.mockResolvedValue(page([bad]));
    const b = parse(await handleToolCall('get_latest_release', { repo: 'ethereum/go-ethereum' })).latest;
    expect(b.security.advisories[0]).toMatchObject({ id: 'GHSA-x', url: null });
  });

  it('get_client_releases carries security and flagsChanged per release', async () => {
    proxyFetch.mockResolvedValue(page([securityRelease]));
    const out = parse(await handleToolCall('get_client_releases', { repo: 'ethereum/go-ethereum' }));
    expect(out.releases[0]).toMatchObject({ security: true, flagsChanged: true });
  });
});
