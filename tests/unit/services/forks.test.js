import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForks, _resetForksMemoForTests, qualifyBareNetwork } from '../../../src/services/forks.js';
import { getForkMentions } from '../../../src/sources/forkFeeds.js';
import { getExplorerTip } from '../../../src/sources/blockscout.js';
import { getAllChains } from '../../../src/store/queries.js';
import { TESTNET_REGISTRY } from '../../fixtures/testnetRegistry.js';

vi.mock('../../../src/store/queries.js', () => ({ getAllChains: vi.fn(() => []) }));

vi.mock('../../../src/sources/forkFeeds.js', () => ({ getForkMentions: vi.fn() }));

let fetchedAt;
// Feed fork mentions to getForks, stamped with the current fetch time.
const serveMentions = (mentions) => getForkMentions.mockResolvedValue({ mentions, fetchedAt, feeds: { status: { ok: true, count: mentions.length } } });
vi.mock('../../../src/sources/blockscout.js', () => ({ getExplorerTip: vi.fn() }));

const fork = (o = {}) => ({ name: null, activationAt: null, activationBlock: null, state: null, ...o });

function event(id, { fork: f, affectedChains, chains = [], page = 'quicknode', publishedAt = '2026-08-14T00:00:00Z' } = {}) {
  return {
    id, title: `t-${id}`, publishedAt, updatedAt: publishedAt,
    statusPage: { id: page }, chains: chains.map(chainId => ({ chainId })),
    enrichment: f ? { fork: f, ...(affectedChains ? { affectedChains } : {}) } : {}
  };
}

describe('getForks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForksMemoForTests();
    getExplorerTip.mockResolvedValue(null);
    getAllChains.mockReturnValue([]);
    fetchedAt = '2026-08-15T00:00:00.000Z';
  });

  it('groups a fork across sources and reports where it came from', async () => {
    serveMentions([
      event('a', { fork: fork({ name: 'Protocol 28', activationAt: '2099-09-16T17:00:00Z' }), affectedChains: ['Stellar Mainnet'], page: 'xlm' }),
      event('b', { fork: fork({ name: 'Protocol 28' }), affectedChains: ['Stellar Mainnet'], page: 'quicknode' })
    ]);

    const out = await getForks();

    expect(out.count).toBe(1);
    expect(out.forks[0]).toMatchObject({ name: 'Protocol 28', network: 'stellar', phase: 'upcoming' });
    expect(out.forks[0].sources.sort()).toEqual(['quicknode', 'xlm']);
  });

  it('does not call the explorer when every activation is already stated', async () => {
    // The common case must cost no network round trip.
    serveMentions([
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['MegaETH Mainnet'] })
    ]);

    await getForks();

    expect(getExplorerTip).not.toHaveBeenCalled();
  });

  it('converts a height-only fork through the explorer', async () => {
    // The Aleo shape: marked as a fork, never named, pinned only to a height.
    serveMentions([
      event('a', { fork: fork({ activationBlock: 18813000 }), chains: [1] })
    ]);
    getExplorerTip.mockResolvedValue({
      height: 18800000, timestampMs: Date.now(), averageBlockSeconds: 10
    });

    const out = await getForks();

    expect(getExplorerTip).toHaveBeenCalledWith(1);
    expect(out.forks[0].activationEvidence).toBe('estimated');
    expect(out.forks[0].phase).toBe('upcoming');
  });

  it('leaves a fork unscheduled rather than guessing when the explorer is unavailable', async () => {
    serveMentions([
      event('a', { fork: fork({ activationBlock: 18813000 }), chains: [1] })
    ]);
    getExplorerTip.mockRejectedValue(new Error('blockscout down'));

    const out = await getForks();

    expect(out.forks[0].activationAt).toBeNull();
    expect(out.forks[0].phase).toBe('unscheduled');
    expect(out.forks[0].activationBlock).toBe(18813000);   // the fact still survives
  });

  it('scheduledOnly drops forks with no known date — what a calendar needs', async () => {
    serveMentions([
      event('dated', { fork: fork({ name: 'Dated', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['A'] }),
      event('undated', { fork: fork({ name: 'Undated' }), affectedChains: ['B'] })
    ]);

    const all = await getForks();
    const cal = await getForks({ scheduledOnly: true });

    expect(all.count).toBe(2);
    expect(cal.count).toBe(1);
    expect(cal.forks[0].name).toBe('Dated');
  });

  it('counts phases over everything matched, not just the page shown', async () => {
    // A caller asking "how many upcoming forks" must not have to add up a truncated list.
    serveMentions([
      event('1', { fork: fork({ name: 'a', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['x'] }),
      event('2', { fork: fork({ name: 'b', activationAt: '2099-09-02T00:00:00Z' }), affectedChains: ['y'] }),
      event('3', { fork: fork({ name: 'c', activationAt: '2026-08-01T00:00:00Z' }), affectedChains: ['z'] })
    ]);

    const out = await getForks({ limit: 1 });

    expect(out.count).toBe(1);
    expect(out.totalMatched).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.byPhase).toMatchObject({ upcoming: 2, past: 1 });
  });

  it('counts every phase even when filtering to one', async () => {
    // Caught by asking the live assistant "what forks are coming up?". It called
    // get_forks(phase='upcoming'), byPhase came back all-zero because it was computed after
    // the filter, and the model answered "0 total matched across all phases" while three
    // unscheduled forks existed.
    serveMentions([
      event('up', { fork: fork({ name: 'up', activationAt: '2099-01-01T00:00:00Z' }), affectedChains: ['x'] }),
      event('un1', { fork: fork({ name: 'un1' }), affectedChains: ['y'] }),
      event('un2', { fork: fork({ name: 'un2' }), affectedChains: ['z'] })
    ]);

    const out = await getForks({ phase: 'upcoming' });

    expect(out.count).toBe(1);            // the filter still applies to the list
    expect(out.totalMatched).toBe(1);
    expect(out.byPhase).toMatchObject({ upcoming: 1, unscheduled: 2 });   // ...but not to the counts
  });

  it('filters by chain and by phase', async () => {
    serveMentions([
      event('1', { fork: fork({ name: 'a', activationAt: '2099-09-01T00:00:00Z' }), chains: [1] }),
      event('2', { fork: fork({ name: 'b', activationAt: '2026-08-01T00:00:00Z' }), chains: [8453] })
    ]);

    expect((await getForks({ chainId: 1 })).count).toBe(1);
    expect((await getForks({ phase: 'past' })).forks[0].name).toBe('b');
  });

  it('compacts member events instead of embedding them whole', async () => {
    // Measured before this: 2210 bytes per fork, so a 50-fork page pretty-printed to ~250 KB
    // and the assistant — which truncates tool results at 8000 chars — would have seen two
    // forks under a header reading count: 50, truncated: false.
    serveMentions([
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['MegaETH Mainnet'] })
    ]);

    const out = await getForks();
    const [member] = out.forks[0].events;

    expect(Object.keys(member).sort()).toEqual(['activationAt', 'class', 'feed', 'provider', 'publishedAt', 'state', 'status', 'title', 'url']);
    // publishedMs is an internal sort key; get_live_incidents already strips it for this reason.
    expect(member.publishedMs).toBeUndefined();
    expect(member.enrichment).toBeUndefined();
  });

  it('does not present an internal scope key as a network name', async () => {
    // `chain:8453` and `unscoped` are grouping keys. The tool description tells the model each
    // fork "carries network", so emitting those put an internal identifier in an answer.
    serveMentions([
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2099-09-01T00:00:00Z' }), chains: [8453] }),
      event('b', { fork: fork({ name: 'Other', activationAt: '2099-09-02T00:00:00Z' }) })
    ]);

    const out = await getForks();

    expect(out.forks.map(f => f.network)).toEqual([null, null]);
  });

  it('reports the feed fetch time, not its own', async () => {
    // loadIncidents serves the last good cache through an upstream outage, so stamping "now"
    // would present hours-old forks as freshly fetched.
    fetchedAt = '2026-08-14T06:00:00.000Z';
    serveMentions([]);

    expect((await getForks()).fetchedAt).toBe('2026-08-14T06:00:00.000Z');
  });

  it('attributes a fork to chains the model resolved, not only declared ones', async () => {
    // An OP Stack window names nine networks and declares none of them; filtering on declared
    // chains alone answered "no forks" for a chain that is genuinely affected.
    serveMentions([{
      id: 'op', title: 'OP Stack upgrade', publishedAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z', statusPage: { id: 'quicknode' }, chains: [],
      enrichment: {
        fork: fork({ name: 'Isthmus', activationAt: '2099-09-01T00:00:00Z' }),
        affectedChains: ['OP Mainnet'],
        chains: [10, 8453]
      }
    }]);

    const out = await getForks({ chainId: 8453 });

    expect(out.count).toBe(1);
    expect(out.forks[0].chains).toEqual(expect.arrayContaining([10, 8453]));
  });

  it('returns an empty result rather than throwing when nothing carries a fork', async () => {
    serveMentions([event('a'), event('b')]);

    const out = await getForks();

    expect(out).toMatchObject({ count: 0, totalMatched: 0, truncated: false });
    expect(out.byPhase).toMatchObject({ upcoming: 0, past: 0, cancelled: 0, unscheduled: 0 });
  });
  it('files a fork named for another network under that network\'s chain, not the poster\'s', async () => {
    getAllChains.mockReturnValue([
      { chainId: 1, name: 'Ethereum Mainnet' },
      { chainId: 42161, name: 'Arbitrum One' },
      // A name shared by many chains is ambiguous and resolves to nothing.
      { chainId: 7, name: 'Testchain' }, { chainId: 8, name: 'Testchain' }, { chainId: 9, name: 'Testchain' }
    ]);
    serveMentions([
      { ...event('arb', { fork: fork({ name: 'Glamsterdam', network: 'Ethereum', activationAt: '2099-12-03T00:00:00Z' }), affectedChains: ['Arbitrum One'], chains: [42161] }), feed: 'forum' },
      { ...event('t', { fork: fork({ name: 'Zeta', network: 'Testchain', activationAt: '2099-12-03T00:00:00Z' }), affectedChains: ['Other'], chains: [5] }), feed: 'forum' }
    ]);

    const out = await getForks();
    const glam = out.forks.find(f => f.name === 'Glamsterdam');
    expect(glam.chains).toEqual([1]);
    expect(out.forks.find(f => f.name === 'Zeta').chains).toEqual([]);
    expect((await getForks({ chainId: 42161 })).forks).toHaveLength(0);
    expect((await getForks({ chainId: 1 })).forks.map(f => f.name)).toEqual(['Glamsterdam']);
  });
  it('resolves a Sepolia fork to the registry\'s Sepolia chain', async () => {
    const own = [
      { chainId: 1, name: 'Ethereum Mainnet' },
      { chainId: 11155111, name: 'Sepolia', tags: ['Testnet'] },
      { chainId: 84532, name: 'Base Sepolia Testnet', tags: ['Testnet'] }
    ];
    // The rest of the registry is what says "Sepolia" names test networks.
    getAllChains.mockReturnValue([...own, ...TESTNET_REGISTRY.filter(c => !own.some(o => o.chainId === c.chainId))]);
    serveMentions([
      { ...event('ef', { fork: fork({ name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: '2099-10-06T13:53:36Z' }), affectedChains: ['Ethereum'], chains: [1] }), feed: 'news' },
      { ...event('base', { fork: fork({ name: 'Jovian', network: 'Base Sepolia', activationAt: '2099-10-07T00:00:00Z' }), affectedChains: ['Base Sepolia'] }), feed: 'forum' }
    ]);

    const out = await getForks();
    expect(out.forks.find(f => f.name === 'Glamsterdam').chains).toEqual([11155111]);
    expect(out.forks.find(f => f.name === 'Jovian').chains).toEqual([84532]);
    expect((await getForks({ chainId: 1 })).forks).toHaveLength(0);
  });
  it('places a "BSC Chapel Testnet" fork on chain 97, which the registry calls "chapel"', async () => {
    getAllChains.mockReturnValue(TESTNET_REGISTRY);
    serveMentions([
      { ...event('bsc', { fork: fork({ name: 'Jenner', network: 'BSC Chapel Testnet', activationAt: '2099-10-29T02:30:00Z' }), affectedChains: ['BSC Chapel Testnet'] }), feed: 'release' }
    ]);
    expect((await getForks()).forks.find(f => f.name === 'Jenner').chains).toEqual([97]);
    expect((await getForks({ chainId: 56 })).forks).toHaveLength(0);
  });

  describe('review fixes', () => {
    const classed = (e, c) => ({ ...e, enrichment: { ...e.enrichment, class: c } });

    it('lists only forks by default and upgrades on request, counting both', async () => {
      serveMentions([
        classed(event('f', { fork: fork({ name: 'Protocol 28', activationAt: '2099-09-16T17:00:00Z' }), affectedChains: ['Stellar'] }), 'planned_hard_fork'),
        classed(event('u', { fork: fork({ name: 'Nanoreth' }), affectedChains: ['HyperEVM'] }), 'planned_software_update')
      ]);
      const def = await getForks();
      expect(def.forks.map(f => f.name)).toEqual(['Protocol 28']);
      expect(def.byKind).toEqual({ fork: 1, upgrade: 1 });
      expect(def.byPhase.unscheduled).toBe(0);
      expect(def.upgradesIncluded).toBe(false);
      const all = await getForks({ include: 'upgrades' });
      expect(all.forks.map(f => f.kind).sort()).toEqual(['fork', 'upgrade']);
      expect(all.byPhase.unscheduled).toBe(1);
    });

    it('resolves a network through the registry aliases, not only chain.name', async () => {
      // Chain 999 is "Wanchain Testnet" by name, HyperEVM by its networks-registry names.
      getAllChains.mockReturnValue([
        { chainId: 999, name: 'Wanchain Testnet', shortName: 'twan', fullName: 'HyperEVM', aliases: ['hyperevm', 'hyperliquid-evm'] },
        { chainId: 7, name: 'Testchain' }, { chainId: 8, name: 'Other', aliases: ['testchain'] }, { chainId: 9, name: 'Testchain' }
      ]);
      serveMentions([
        // No fork.network and no declared chain: resolution must still run.
        event('h', { fork: fork({ name: 'Nanoreth', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['HyperEVM'] }),
        event('t', { fork: fork({ name: 'Zeta', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['Testchain'] })
      ]);
      expect((await getForks({ chainId: 999 })).forks.map(f => f.name)).toEqual(['Nanoreth']);
      // Three chains answer to "testchain": ambiguous, resolves to nothing.
      expect((await getForks()).forks.find(f => f.name === 'Zeta').chains).toEqual([]);
    });

    it('builds once per feed snapshot and registry version', async () => {
      const chains = [{ chainId: 1, name: 'Ethereum Mainnet' }];
      getAllChains.mockReturnValue(chains);
      const mentions = [event('a', { fork: fork({ activationBlock: 18813000 }), chains: [1] })];
      serveMentions(mentions);
      await getForks();
      await getForks({ phase: 'past' });
      expect(getExplorerTip).toHaveBeenCalledTimes(1);
      getAllChains.mockReturnValue([...chains]);   // registry reloaded
      await getForks();
      expect(getExplorerTip).toHaveBeenCalledTimes(2);
    });

    it('surfaces a dropped date and a low-confidence member on the event', async () => {
      serveMentions([{
        ...event('a', { fork: fork({ name: 'Alpenglow', activationAt: '2024-10-21T00:00:00Z', state: 'scheduled' }), affectedChains: ['Solana'] }),
        enrichment: { class: 'planned_hard_fork', lowConfidence: true, affectedChains: ['Solana'], fork: fork({ name: 'Alpenglow', activationAt: '2024-10-21T00:00:00Z' }) }
      }]);
      const [f] = (await getForks()).forks;
      expect(f).toMatchObject({ activationAt: null, phase: 'unscheduled', networks: ['solana'] });
      expect(f.events[0]).toMatchObject({ activationAt: null, implausibleActivationAt: '2024-10-21T00:00:00Z', lowConfidence: true });
    });
  });
});

describe('bare "Mainnet" / "Testnet" fork networks', () => {
  const chains = [
    { chainId: 1, name: 'Ethereum Mainnet', theGraph: { id: 'mainnet' }, 'theGraph-id': 'mainnet', tags: [] },
    { chainId: 314, name: 'Filecoin - Mainnet', tags: [] },
    { chainId: 314159, name: 'Filecoin - Calibration testnet', tags: ['Testnet'] },
    { chainId: 80002, name: 'Amoy', tags: ['Testnet', 'L2'] }
  ];
  const byId = new Map(chains.map((c) => [c.chainId, c]));
  const releaseMention = (network, chainIds) => ({
    feed: 'release', title: 'v1', url: 'u', publishedAt: '2026-09-01T00:00:00Z',
    chains: chainIds.map((chainId) => ({ chainId })), statusPage: { id: 'repo', kind: 'release' },
    enrichment: { class: 'planned_hard_fork', chains: [], affectedChains: [], fork: fork({ name: 'Solstice', network, activationAt: '2099-10-19T12:59:30Z' }) }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForksMemoForTests();
    getAllChains.mockReturnValue(chains);
    fetchedAt = '2026-08-15T00:00:00.000Z';
  });

  it('reads "Mainnet" as the one mainnet chain the release names, not as Ethereum', async () => {
    // Forest's notes put Filecoin's Solstice on "Mainnet"; "mainnet" is The Graph's id for chain 1.
    serveMentions([releaseMention('Mainnet', [314, 314159])]);

    const out = await getForks();

    expect(out.forks[0].chains).toEqual([314]);
  });

  it('drops the chains when none is of the stated kind', async () => {
    // Heimdall's "Mainnet" Lugano release names only Amoy, a testnet.
    serveMentions([releaseMention('Mainnet', [80002])]);

    const out = await getForks();

    expect(out.forks[0].chains).toEqual([]);
  });

  it('does not let a named testnet bring back the chains the qualifier dropped', async () => {
    // "Mainnet" + chain 80002 + affectedChains ["Amoy"]: the named scope would resolve to Amoy.
    const m = releaseMention('Mainnet', [80002]);
    m.enrichment.affectedChains = ['Amoy', 'Polygon Mainnet'];
    expect(qualifyBareNetwork(m, byId).enrichment.affectedChains).toEqual(['Polygon Mainnet']);
    serveMentions([{ ...m, enrichment: { ...m.enrichment, affectedChains: ['Amoy'] } }]);
    const [f] = (await getForks()).forks;
    expect(f.chains).toEqual([]);
  });

  it('leaves a named network alone', () => {
    const m = releaseMention('Filecoin Calibration', [314159]);
    expect(qualifyBareNetwork(m, byId)).toBe(m);
  });

  it('reads "Testnet" as the one testnet chain', () => {
    const out = qualifyBareNetwork(releaseMention('Testnet', [314, 314159]), byId);
    expect(out.enrichment.fork.network).toBe('Filecoin - Calibration testnet');
    expect(out.chains).toEqual([{ chainId: 314159 }]);
  });
});
