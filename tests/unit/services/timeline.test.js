import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTimeline, getTimeline, forkAliases, normalizeVersion, namesFork, _resetTimelineMemoForTests } from '../../../src/services/timeline.js';
import { getAllForks } from '../../../src/services/forks.js';
import { learnForkNames, _resetForkNamesForTests } from '../../../src/domain/forkNames.js';
import { learnNetworkWords } from '../../../src/domain/networkWords.js';
import { TESTNET_REGISTRY } from '../../fixtures/testnetRegistry.js';
import { getUpgradeTimeline } from '../../../src/services/upgrades.js';
import { getClientReleases, clientFeedConfigured } from '../../../src/sources/clientFeed.js';
import { getWeb3News } from '../../../src/sources/web3News.js';
import { getForumNews } from '../../../src/sources/forumNews.js';

vi.mock('../../../src/services/forks.js', () => ({ getAllForks: vi.fn() }));
vi.mock('../../../src/services/upgrades.js', async (importOriginal) => ({ ...(await importOriginal()), getUpgradeTimeline: vi.fn() }));
vi.mock('../../../src/sources/clientFeed.js', () => ({ getClientReleases: vi.fn(), clientFeedConfigured: vi.fn(() => true) }));
vi.mock('../../../src/sources/web3News.js', () => ({ getWeb3News: vi.fn() }));
vi.mock('../../../src/sources/forumNews.js', () => ({ getForumNews: vi.fn() }));
vi.mock('../../../src/store/queries.js', async () => ({
  getChainById: vi.fn((id) => ({ 8453: { name: 'Base', tags: [] }, 1: { name: 'Ethereum Mainnet', tags: [] }, 11155111: { name: 'Sepolia', tags: ['Testnet'] } })[id] ?? null),
  getAllChains: vi.fn(() => [])
}));

const NOW = Date.parse('2026-10-17T00:00:00Z');

// A presented fork entity (services/forks.js).
function fork(o = {}) {
  const network = 'network' in o ? o.network : 'bsc chapel testnet';
  return {
    key: `name:${(o.name ?? 'x').toLowerCase()}@${network ?? 'unscoped'}`,
    name: 'Jenner', kind: 'fork', network, networks: network ? [network] : [], chains: [97],
    activationAt: '2026-10-29T02:30:00.000Z', activationEvidence: 'stated', activationPrecision: 'time', activationBlock: null,
    state: 'scheduled', phase: 'upcoming', sources: [], feeds: ['release'], events: [], ...o
  };
}

const releaseEvent = (o = {}) => ({
  feed: 'release', title: 'v1.8.1', url: 'https://github.com/bnb-chain/bsc/releases/tag/v1.8.1', publishedAt: '2026-10-15T00:00:00Z',
  status: null, provider: 'github:bnb-chain/bsc', class: 'planned_hard_fork', activationAt: '2026-10-29T02:30:00Z',
  release: { repo: 'bnb-chain/bsc', version: 'v1.8.1', mandatory: true }, ...o
});

// A provider window (services/upgrades.js).
function window(o = {}) {
  return {
    incidentId: 'quicknode:w1', title: 'Urgent BSC Chapel - Testnet - Upgrade to v1.8.1', url: 'https://status.quicknode.com/w1',
    provider: 'quicknode', status: 'maintenance_scheduled', urgency: 'urgent', software: [{ client: null, version: 'v1.8.1' }],
    activationAt: '2026-10-22T00:00:00.000Z', activationEvidence: 'window', windowMinutes: 60,
    chainIds: [97], networkNames: ['Urgent BSC Chapel'], networkSlugs: ['bsc-chapel'],
    followedByIncidents: [], discussion: [], coverage: [], ...o
  };
}

const build = (inputs) => buildTimeline({ now: NOW, chainName: () => null, ...inputs });

describe('buildTimeline — hardforks', () => {
  it('keeps a monorepo\'s components that share a version as separate releases', () => {
    const lotus = (tag, component, version) => releaseEvent({
      title: tag, url: `https://github.com/filecoin-project/lotus/releases/tag/${tag}`, provider: 'github:filecoin-project/lotus',
      release: { repo: 'filecoin-project/lotus', component, version, mandatory: true }
    });
    const [entry] = build({
      forks: [fork({ name: 'Solstice', events: [lotus('v1.38.0', null, '1.38.0'), lotus('miner/v1.38.0', 'miner', '1.38.0'), lotus('v1.38.0', null, '1.38.0')] })]
    });
    expect(entry.releases.map((r) => [r.component ?? null, r.version])).toEqual([[null, '1.38.0'], ['miner', '1.38.0']]);
    expect(entry.counts.releases).toBe(2);
  });

  it('groups a fork\'s release, provider window and news under it', () => {
    const entries = build({
      forks: [fork({
        events: [
          releaseEvent(),
          { feed: 'forum', title: 'Jenner hard fork on Chapel', url: 'https://forum/1', publishedAt: '2026-10-10T00:00:00Z', provider: 'bnb-forum' }
        ]
      })],
      upgrades: [window()]
    });

    expect(entries).toHaveLength(1);
    const [jenner] = entries;
    expect(jenner).toMatchObject({ type: 'hardfork', name: 'Jenner', urgency: 'mandatory', phase: 'upcoming', chainIds: [97] });
    expect(jenner.releases).toEqual([expect.objectContaining({ repo: 'bnb-chain/bsc', version: 'v1.8.1', mandatory: true })]);
    // Joined by the version the fork's release ships.
    expect(jenner.providerUpdates).toEqual([expect.objectContaining({ provider: 'quicknode', activationEvidence: 'window' })]);
    expect(jenner.news).toEqual([expect.objectContaining({ feed: 'forum', url: 'https://forum/1' })]);
    expect(jenner.counts).toEqual({ releases: 1, providerUpdates: 1, news: 1, followedByIncidents: 0 });
    // The client team's own release is the primary link.
    expect(jenner.url).toBe('https://github.com/bnb-chain/bsc/releases/tag/v1.8.1');
  });

  it('joins a window that is one of the fork\'s own status events, replacing the bare event', () => {
    const entries = build({
      forks: [fork({ events: [{ feed: 'status', title: 'Urgent BSC Chapel - Testnet - Upgrade to v1.8.1', provider: 'quicknode', url: 'u', status: 'maintenance_scheduled' }] })],
      upgrades: [window({ software: [] })]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].providerUpdates).toHaveLength(1);
    expect(entries[0].providerUpdates[0]).toMatchObject({ activationEvidence: 'window', windowMinutes: 60 });
  });

  it('joins a window naming the fork', () => {
    const entries = build({
      forks: [fork()],
      upgrades: [window({ title: 'BSC Chapel Jenner upgrade', software: [] })]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].providerUpdates).toHaveLength(1);
  });

  it('never joins a window on another network, even with the same version', () => {
    const entries = build({
      forks: [fork({ events: [releaseEvent()] })],
      upgrades: [window({ chainIds: [56], networkSlugs: ['bnb-smart'], networkNames: ['BSC Mainnet'] })]
    });
    expect(entries.map((e) => e.type).sort()).toEqual(['hardfork', 'software_update']);
    expect(entries.find((e) => e.type === 'hardfork').providerUpdates).toEqual([]);
  });

  it('does not widen a fork to the other networks a provider window covered', () => {
    // QuickNode's one "Sepolia/Hoodi" window does not make Sepolia's activation a Hoodi one.
    const entries = build({
      forks: [fork({ events: [releaseEvent()] })],
      upgrades: [window({ chainIds: [97, 560048], networkSlugs: ['bsc-chapel', 'hoodi'] })]
    });
    expect(entries[0].chainIds).toEqual([97]);
  });

  it('attaches a window covering two networks to the fork on each', () => {
    const sepolia = fork({ key: 'name:glamsterdam@sepolia', name: 'Glamsterdam', network: 'ethereum sepolia', chains: [11155111], activationAt: '2026-10-06T00:00:00.000Z', events: [releaseEvent({ release: { repo: 'ethereum/go-ethereum', version: 'v1.17.6' } })] });
    const hoodi = fork({ key: 'name:glamsterdam@hoodi', name: 'Glamsterdam', network: 'ethereum hoodi', chains: [560048], activationAt: '2026-10-26T00:00:00.000Z', events: [releaseEvent({ release: { repo: 'ethereum/go-ethereum', version: 'v1.17.6' } })] });
    const entries = build({
      forks: [sepolia, hoodi],
      upgrades: [window({ title: 'Ethereum - Sepolia/Hoodi - Upgrade to Geth-v1.17.6', software: [{ client: 'geth', version: 'v1.17.6' }], chainIds: [11155111, 560048], networkSlugs: ['ethereum-sepolia', 'ethereum-hoodi'] })]
    });
    expect(entries.map((e) => [e.chainIds[0], e.providerUpdates.length]).sort()).toEqual([[11155111, 1], [560048, 1]]);
  });

  it('knows geth by its repository however the release writes it', () => {
    for (const repo of ['https://github.com/ethereum/go-ethereum', 'go-ethereum']) {
      const entries = build({
        forks: [fork({ key: 'name:glamsterdam@sepolia', name: 'Glamsterdam', network: 'ethereum sepolia', chains: [11155111], activationAt: '2026-10-06T00:00:00.000Z', events: [releaseEvent({ release: { repo, version: 'v1.17.6' } })] })],
        upgrades: [window({ title: 'Ethereum - Sepolia - Upgrade to Geth-v1.17.6', software: [{ client: 'geth', version: 'v1.17.6' }], chainIds: [11155111], networkSlugs: ['ethereum-sepolia'] })]
      });
      expect(entries[0].providerUpdates).toHaveLength(1);
    }
  });

  it('names what to run for a fork called off before it activated, and the deadline', () => {
    // Scheduled by one release, called off by the next; a provider window still says the old version.
    const called = fork({
      phase: 'cancelled', state: 'cancelled', activationAt: '2026-10-29T02:30:00.000Z',
      events: [
        releaseEvent({ state: 'scheduled' }),
        releaseEvent({ title: 'v1.8.2', url: 'https://github.com/bnb-chain/bsc/releases/tag/v1.8.2', publishedAt: '2026-10-16T00:00:00Z', activationAt: null, state: 'cancelled', release: { repo: 'bnb-chain/bsc', version: 'v1.8.2', mandatory: true } })
      ]
    });
    const later = fork({ key: 'name:later@x', name: 'Later', activationAt: '2026-11-30T00:00:00.000Z', events: [] });
    // The window names the client its own way: still the release's row.
    const entries = build({ forks: [later, called], upgrades: [window({ software: [{ client: 'BSC', version: 'v1.8.1' }] })] });
    const entry = entries.find((e) => e.name === 'Jenner');
    expect(entry.phase).toBe('cancelled');
    expect(entry.software).toEqual([{ client: 'bnb-chain/bsc', version: 'v1.8.2' }]);
    // The window's version-only "v1.8.1" is the release's row, not a second one.
    expect(entry.supersededSoftware).toEqual([{ client: 'bnb-chain/bsc', version: 'v1.8.1' }]);
    expect(entry.upgradeBy).toBe('2026-10-29T02:30:00.000Z');
    expect(entry.urgency).toBe('mandatory');
    expect(entry.releases.map((r) => [r.version, r.forkState])).toEqual([['v1.8.1', 'scheduled'], ['v1.8.2', 'cancelled']]);
    // Still something to act on: listed with the upcoming forks, by its deadline (before November's).
    expect(entries.map((e) => e.name).slice(0, 2)).toEqual(['Jenner', 'Later']);
  });

  it('keeps two clients that share a version apart when listing what to run', () => {
    const rel = (repo, version, state, day) => releaseEvent({ title: version, url: `https://github.com/${repo}/releases/tag/${version}`, publishedAt: `2026-10-${day}T00:00:00Z`, state, release: { repo, version, mandatory: true } });
    const [entry] = build({ forks: [fork({ phase: 'cancelled', state: 'cancelled', events: [
      rel('Consensys/teku', '26.10.1', 'scheduled', '10'), rel('status-im/nimbus-eth2', '26.10.1', 'scheduled', '11'),
      rel('Consensys/teku', '26.10.2', 'cancelled', '15'), rel('status-im/nimbus-eth2', '26.10.2', 'cancelled', '16')
    ] })] });
    expect(entry.software.map((x) => x.client)).toEqual(['Consensys/teku', 'status-im/nimbus-eth2']);
    expect(entry.supersededSoftware).toHaveLength(2);
    expect(entry.supersededSoftware.map((x) => `${x.client} ${x.version}`)).toEqual(['Consensys/teku 26.10.1', 'status-im/nimbus-eth2 26.10.1']);
  });

  it('sets no deadline once the original activation has passed, and leaves a fork nobody called off alone', () => {
    const passed = fork({ phase: 'cancelled', state: 'cancelled', activationAt: '2026-10-01T00:00:00.000Z', events: [releaseEvent({ state: 'cancelled' })] });
    expect(build({ forks: [passed] })[0].upgradeBy).toBeUndefined();
    const scheduled = build({ forks: [fork({ events: [releaseEvent({ state: 'scheduled' })] })] })[0];
    expect(scheduled.upgradeBy).toBeUndefined();
    expect(scheduled.supersededSoftware).toBeUndefined();
  });

  it('keeps a fork\'s newest releases when it has more than it lists', () => {
    const events = Array.from({ length: 25 }, (_, i) => releaseEvent({
      title: `v1.${i}`, url: `https://github.com/bnb-chain/bsc/releases/tag/v1.${i}`, publishedAt: new Date(Date.parse('2026-10-01T00:00:00Z') + i * 36e5).toISOString(),
      release: { repo: 'bnb-chain/bsc', version: `v1.${i}`, mandatory: false }
    }));
    const [entry] = build({ forks: [fork({ events })] });
    expect(entry.counts.releases).toBe(25);
    expect(entry.releases).toHaveLength(20);
    expect(entry.releases.at(-1).version).toBe('v1.24');
  });

  it('does not copy a window\'s fallout or news onto a fork', () => {
    const entries = build({
      forks: [fork({ events: [releaseEvent()] })],
      upgrades: [window({
        followedByIncidents: [{ title: 'Other chain outage', url: 'https://status/x', hoursAfterActivation: 1 }],
        coverage: [{ title: 'Unrelated proposal', url: 'https://news/x' }]
      })]
    });
    expect(entries[0].providerUpdates).toHaveLength(1);
    expect(entries[0].followedByIncidents).toEqual([]);
    expect(entries[0].news).toEqual([]);
  });

  it('adds incidents on the fork\'s network in the day after activation as fallout', () => {
    const activationMs = Date.parse('2026-10-01T00:00:00Z');
    const inc = {
      updates: [{ chains: [{ chainId: 97 }], networkSlugs: [], networkNames: [] }],
      first: { publishedMs: activationMs + 3 * 3600_000, publishedAt: '2026-10-01T03:00:00Z' },
      latest: { title: 'Chapel RPC errors', url: 'https://status/inc', status: 'resolved', publishedMs: activationMs + 5 * 3600_000, ongoing: false }
    };
    const entries = build({
      forks: [fork({ activationAt: '2026-10-01T00:00:00.000Z', phase: 'past' })],
      incidentGroups: [inc]
    });
    expect(entries[0].followedByIncidents).toEqual([expect.objectContaining({ title: 'Chapel RPC errors', hoursAfterActivation: 3, suspectedCause: 'upgrade' })]);
  });
});

describe('buildTimeline — not a fork', () => {
  it('files a "fork" named after a network as a software update', () => {
    // A release adding Hoodi support, read as a fork named "Hoodi". The registry says Hoodi is a network.
    learnNetworkWords(TESTNET_REGISTRY);
    const entries = build({ forks: [fork({ name: 'Hoodi', network: null, chains: [1], activationAt: null, phase: 'unscheduled' })] });
    expect(entries[0].type).toBe('software_update');
  });
});

describe('buildTimeline — one fork, several names', () => {
  beforeEach(() => _resetForkNamesForTests());

  it('merges geth\'s Amsterdam and Prysm\'s Gloas on one network into Glamsterdam', () => {
    // Taught by the feeds, not a table: Hoodi's activation was reported under all three names.
    learnForkNames([{ name: 'Glamsterdam', aliases: ['Gloas', 'Amsterdam'], events: [{}, {}, {}] }]);
    const entries = build({
      forks: [
        fork({ key: 'a', name: 'Amsterdam', network: 'ethereum sepolia', chains: [11155111], events: [releaseEvent({ release: { repo: 'ethereum/go-ethereum', version: 'v1.17.6' } })] }),
        fork({ key: 'b', name: 'Gloas', network: 'sepolia', chains: [11155111], activationAt: null, activationEvidence: null, phase: 'unscheduled', events: [releaseEvent({ release: { repo: 'offchainlabs/prysm', version: 'v7.2.0' } })] })
      ]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'Glamsterdam', layerName: 'Amsterdam', activationAt: '2026-10-29T02:30:00.000Z' });
    expect(entries[0].releases.map((r) => r.repo).sort()).toEqual(['ethereum/go-ethereum', 'offchainlabs/prysm']);
  });

  it('keeps two names apart until the feeds show they are one activation', () => {
    const entries = build({
      forks: [
        fork({ key: 'a', name: 'Amsterdam', network: 'ethereum sepolia', chains: [11155111] }),
        fork({ key: 'b', name: 'Gloas', network: 'sepolia', chains: [11155111], activationAt: null, activationEvidence: null, phase: 'unscheduled' })
      ]
    });
    expect(entries.map((e) => e.name).sort()).toEqual(['Amsterdam', 'Gloas']);
  });

  it('keeps the same fork on different networks apart', () => {
    const entries = build({
      forks: [
        fork({ key: 'a', name: 'Glamsterdam', network: 'ethereum sepolia', chains: [11155111] }),
        fork({ key: 'b', name: 'Glamsterdam', network: 'ethereum hoodi', chains: [560048] })
      ]
    });
    expect(entries).toHaveLength(2);
  });

  it('merges one fork spelled two ways on the same chain', () => {
    const entries = build({
      forks: [
        fork({ key: 'a', network: 'bsc chapel testnet' }),
        fork({ key: 'b', network: 'bnb smart chain chapel testnet' })
      ]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].networkNames).toEqual(['bsc chapel testnet', 'bnb smart chain chapel testnet']);
  });

  it('folds an undated "adds support" release into the one fork of that name', () => {
    const entries = build({
      forks: [
        fork({ key: 'a', name: 'Lugano', network: 'polygon', chains: [137] }),
        fork({ key: 'b', name: 'Lugano HF', kind: 'upgrade', network: null, chains: [], activationAt: null, phase: 'unscheduled', events: [releaseEvent({ release: { repo: '0xpolygon/bor', version: 'v2.5.0' } })] })
      ]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].releases.map((r) => r.repo)).toEqual(['0xpolygon/bor']);
  });

  it('folds an unchained support release into the mainnet activation among several', () => {
    const isTestnet = (id) => id === 11155111;
    const entries = buildTimeline({
      now: NOW,
      isTestnet,
      forks: [
        fork({ key: 'a', name: 'Glamsterdam', network: 'ethereum', chains: [1] }),
        fork({ key: 'b', name: 'Glamsterdam', network: 'ethereum sepolia', chains: [11155111] }),
        fork({ key: 'c', name: 'Glamsterdam', kind: 'upgrade', network: null, chains: [], activationAt: null, phase: 'unscheduled', events: [releaseEvent({ release: { repo: 'erigontech/erigon', version: 'v3.5.0' } })] })
      ]
    });
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.chainIds.includes(1)).releases.map((r) => r.repo)).toEqual(['erigontech/erigon']);
  });

  it('leaves a support release unjoined when several mainnets share the name', () => {
    // Ethereum, Taiko and World Chain each have a mainnet Glamsterdam.
    const entries = build({
      forks: [
        fork({ key: 'a', name: 'Glamsterdam', network: 'ethereum', chains: [1] }),
        fork({ key: 'b', name: 'Glamsterdam', network: 'taiko', chains: [167000] }),
        fork({ key: 'c', name: 'Glamsterdam', kind: 'upgrade', network: null, chains: [], activationAt: null, phase: 'unscheduled', events: [releaseEvent()] })
      ]
    });
    expect(entries.map((e) => e.type).sort()).toEqual(['hardfork', 'hardfork', 'software_update']);
  });
});

describe('buildTimeline — software updates and maintenance', () => {
  it('groups each provider\'s window for one version on one network into one update', () => {
    const entries = buildTimeline({
      now: NOW,
      chainName: (id) => (id === 8453 ? 'Base' : null),
      upgrades: [
        window({ incidentId: 'q', provider: 'quicknode', title: '[Urgent] Base - Sepolia and Mainnet- Upgrade to v1.5.0', software: [{ client: null, version: 'v1.5.0' }], chainIds: [8453], networkSlugs: ['base'], networkNames: ['Urgent Base'], activationAt: '2026-10-19T00:00:00.000Z', activationEvidence: 'scheduled' }),
        window({ incidentId: 'b', provider: 'blockdaemon', title: '[Base] - Mainnet and Testnet update to v1.5.0', software: [{ client: null, version: '1.5.0' }], chainIds: [8453], networkSlugs: ['base'], networkNames: ['[Base'], activationAt: '2026-10-19T06:00:00.000Z', activationEvidence: 'window' })
      ],
      releases: [{ title: 'v1.5.0', url: 'https://github.com/base/node/releases/v1.5.0', publishedAt: '2026-10-14T00:00:00Z', chains: [{ chainId: 8453, name: 'Base' }], chainsFrom: 'release', release: { repo: 'base/node', version: 'v1.5.0', mandatory: false }, enrichment: { class: 'planned_software_update' } }]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'software_update', title: 'Base · v1.5.0', providers: ['quicknode', 'blockdaemon'] });
    // Providers' decorations ("Urgent Base", "[Base") are not network names.
    expect(entries[0].networkNames).toEqual(['Base']);
    // The strongest evidence wins: a stated window over a scheduled entry.
    expect(entries[0]).toMatchObject({ activationAt: '2026-10-19T06:00:00.000Z', activationEvidence: 'window', phase: 'upcoming' });
    expect(entries[0].releases).toEqual([expect.objectContaining({ repo: 'base/node' })]);
  });

  it('keeps two clients at the same version apart', () => {
    const entries = build({
      upgrades: [
        window({ incidentId: 'a', title: 'Base - Upgrade op-geth to v1.0.0', software: [{ client: 'op-geth', version: 'v1.0.0' }], chainIds: [8453], networkSlugs: ['base'] }),
        window({ incidentId: 'b', title: 'Base - Upgrade op-reth to v1.0.0', software: [{ client: 'op-reth', version: 'v1.0.0' }], chainIds: [8453], networkSlugs: ['base'] }),
        window({ incidentId: 'c', provider: 'blockdaemon', title: 'Base op-geth v1.0.0', software: [{ client: null, version: '1.0.0' }], chainIds: [8453], networkSlugs: ['base'] })
      ],
      releases: [{ title: 'v1.0.0', url: 'u', publishedAt: '2026-10-14T00:00:00Z', chains: [{ chainId: 8453, name: 'Base' }], chainsFrom: 'release', release: { repo: 'paradigmxyz/reth', version: 'v1.0.0', mandatory: true }, enrichment: { class: 'urgent_software_fix' } }]
    });
    const updates = entries.filter((e) => e.type === 'software_update');
    // op-geth with the unnamed window; op-reth alone — the reth release joins it, not op-geth.
    expect(updates.map((u) => u.providerUpdates.length).sort()).toEqual([1, 2]);
    expect(updates.find((u) => u.software.some((x) => x.client === 'op-reth')).releases).toHaveLength(1);
    expect(updates.find((u) => u.software.some((x) => x.client === 'op-geth')).releases).toHaveLength(0);
  });

  it('files planned work closed as resolved, with no date, as history', () => {
    const entries = build({ upgrades: [window({ status: 'resolved', activationAt: null, activationEvidence: null })] });
    expect(entries[0]).toMatchObject({ type: 'software_update', phase: 'past' });
  });

  it('lists a window naming no software as maintenance', () => {
    const entries = build({ upgrades: [window({ title: 'Internal platform upgrades', software: [] })] });
    expect(entries).toEqual([expect.objectContaining({ type: 'maintenance', title: 'Internal platform upgrades', provider: 'quicknode' })]);
  });

  it('makes an urgent or mandatory release an event of its own, and drops a routine one', () => {
    const rel = (o) => ({ title: 'r', url: `https://r/${o.v}`, publishedAt: '2026-10-10T00:00:00Z', chains: [{ chainId: 10, name: 'OP Mainnet' }], chainsFrom: 'release', release: { repo: 'ethereum-optimism/op-geth', version: o.v, mandatory: o.mandatory ?? false }, enrichment: { class: o.cls } });
    const entries = build({
      releases: [
        rel({ v: 'v1.0.1', cls: 'urgent_software_fix' }),
        rel({ v: 'v1.0.2', cls: 'planned_software_update', mandatory: true }),
        rel({ v: 'v1.0.3', cls: 'planned_software_update' }),
        rel({ v: 'v1.0.4', cls: 'routine_release' })
      ]
    });
    expect(entries.map((e) => e.releases[0].version).sort()).toEqual(['v1.0.1', 'v1.0.2']);
    expect(entries.every((e) => e.type === 'software_update' && e.activationEvidence === 'released')).toBe(true);
  });

  it('keeps ids unique when two rollouts derive the same one', () => {
    const entries = build({
      upgrades: [
        window({ incidentId: 'x', software: [{ version: '1.0' }], chainIds: [1], networkSlugs: ['a'] }),
        window({ incidentId: 'y', software: [{ version: '1.0' }], chainIds: [2], networkSlugs: ['b'], networkNames: ['Other'] })
      ]
    });
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });
});

describe('buildTimeline — news', () => {
  it('joins an article naming the fork and no chain to the one fork of that name', () => {
    const entries = build({
      forks: [fork({ name: 'Fusaka', network: 'ethereum', chains: [1], activationAt: '2025-12-03T21:49:00.000Z', phase: 'past' })],
      news: [{ title: 'Fusaka goes live on Ethereum', url: 'https://news/1', publishedAt: '2025-12-04T00:00:00Z', chains: [], source: { name: 'The Block' } }]
    });
    expect(entries[0].news).toEqual([expect.objectContaining({ feed: 'news', source: 'The Block', url: 'https://news/1' })]);
  });

  it('leaves an unchained article unjoined when the name covers several networks', () => {
    const entries = build({
      forks: [
        fork({ key: 'a', name: 'Fusaka', network: 'ethereum', chains: [1] }),
        fork({ key: 'b', name: 'Fusaka', network: 'gnosis', chains: [100] })
      ],
      news: [{ title: 'Fusaka explained', url: 'https://news/2', publishedAt: '2026-10-01T00:00:00Z', chains: [] }]
    });
    expect(entries.flatMap((e) => e.news)).toEqual([]);
  });

  it('ignores an article far outside the fork\'s window', () => {
    const entries = build({
      forks: [fork({ name: 'Fusaka', network: 'ethereum', chains: [1], activationAt: '2025-12-03T21:49:00.000Z', phase: 'past' })],
      news: [{ title: 'Remember Fusaka?', url: 'https://news/3', publishedAt: '2026-10-01T00:00:00Z', chains: [{ chainId: 1 }] }]
    });
    expect(entries[0].news).toEqual([]);
  });
});

describe('name helpers', () => {
  it('reads every name a fork answers to', () => {
    expect(forkAliases('nv29 (Solstice)')).toEqual(['nv29 solstice', 'nv29', 'solstice']);
    expect(forkAliases('Gloas')).toEqual(['gloas']);
    learnForkNames([{ name: 'Glamsterdam', aliases: ['Gloas'], events: [{}] }]);
    expect(forkAliases('Gloas')).toEqual(['glamsterdam']);
    // A name that states its alias teaches it; a slash list of two forks does not.
    learnForkNames([{ name: 'Fusaka (Fulu)', events: [{}] }, { name: 'Berlin/London', events: [{}] }]);
    expect([forkAliases('Fulu'), forkAliases('London')]).toEqual([['fusaka'], ['london']]);
    _resetForkNamesForTests();
    expect(forkAliases('Hard Fork')).toEqual([]);
  });

  it('normalizes versions', () => {
    expect(normalizeVersion('v1.8.1')).toBe('1.8.1');
    expect(normalizeVersion('Geth-v1.17.6')).toBe('1.17.6');
    expect(normalizeVersion('nightly')).toBeNull();
  });

  it('matches a fork name as a word only', () => {
    expect(namesFork('Fusaka mainnet date set', 'fusaka')).toBe(true);
    expect(namesFork('Prefusakaesque', 'fusaka')).toBe(false);
    expect(namesFork('Protocol-28 vote', 'protocol 28')).toBe(true);
    // Too short to mean anything on its own.
    expect(namesFork('v29 is out', 'v29')).toBe(false);
  });
});

describe('getTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTimelineMemoForTests();
    clientFeedConfigured.mockReturnValue(true);
    getAllForks.mockResolvedValue({ forks: [fork({ events: [releaseEvent()] }), fork({ key: 'f', name: 'Fusaka', network: 'ethereum', chains: [1], activationAt: '2025-12-03T21:49:00.000Z', phase: 'past' })], feeds: { release: { ok: true } }, fetchedAt: '2026-10-17T00:00:00.000Z' });
    getUpgradeTimeline.mockResolvedValue({ upgrades: [window({ incidentId: 'm', title: 'Internal platform upgrades', software: [], chainIds: [1], networkSlugs: ['ethereum'], activationAt: '2025-06-01T00:00:00.000Z', status: 'maintenance_completed' })], incidentGroups: [] });
    getClientReleases.mockResolvedValue({ items: [] });
    getWeb3News.mockResolvedValue({ news: [] });
    getForumNews.mockResolvedValue({ news: [] });
  });

  it('filters to one chain\'s hardfork history and counts before the phase filter', async () => {
    const out = await getTimeline({ chainId: 1, type: 'hardfork' });
    expect(out.entries.map((e) => e.name)).toEqual(['Fusaka']);
    expect(out.byType).toEqual({ hardfork: 1, software_update: 0, maintenance: 0 });

    const upcoming = await getTimeline({ chainId: 1, phase: 'upcoming' });
    expect(upcoming.entries).toEqual([]);
    expect(upcoming.byPhase.past).toBe(2);
  });

  it('filters by activation date, dropping undated events', async () => {
    const out = await getTimeline({ since: '2026-01-01T00:00:00Z' });
    expect(out.entries.map((e) => e.title)).toEqual(['Jenner']);
    // A bare date includes that whole day: Fusaka activated at 21:49 on it.
    const until = await getTimeline({ until: '2025-12-03' });
    expect(until.entries.map((e) => e.title)).toEqual(['Fusaka', 'Internal platform upgrades']);
  });

  it('answers without a source that is down, and says so', async () => {
    getClientReleases.mockRejectedValue(new Error('feed down'));
    getWeb3News.mockRejectedValue(new Error('news down'));
    const out = await getTimeline();
    expect(out.sources.releases.ok).toBe(false);
    expect(out.sources.news.ok).toBe(false);
    expect(out.totalMatched).toBe(3);
  });

  it('says when the release feed is not configured', async () => {
    clientFeedConfigured.mockReturnValue(false);
    const out = await getTimeline();
    expect(out.sources.releases).toEqual({ ok: false, disabled: true });
    expect(getClientReleases).not.toHaveBeenCalled();
  });

  it('fails only when neither the fork feeds nor the status feed answered', async () => {
    getAllForks.mockRejectedValue(new Error('forks down'));
    getUpgradeTimeline.mockRejectedValue(new Error('status down'));
    await expect(getTimeline()).rejects.toThrow(/Timeline sources unavailable/);
  });

  it('caps the page and reports truncation', async () => {
    const out = await getTimeline({ limit: 1 });
    expect(out).toMatchObject({ count: 1, totalMatched: 3, truncated: true });
  });
});
