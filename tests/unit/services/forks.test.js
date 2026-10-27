import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForks, _resetForksMemoForTests, qualifyBareNetwork } from '../../../src/services/forks.js';
import { getForkMentions } from '../../../src/sources/forkFeeds.js';
import { getExplorerTip } from '../../../src/sources/blockscout.js';
import { getAllChains } from '../../../src/store/queries.js';
import { KIND_REGISTRY } from '../../fixtures/structuralWords.js';
import { TESTNET_REGISTRY } from '../../fixtures/testnetRegistry.js';
import { getRepositoryChains } from '../../../src/sources/networkResearch.js';

vi.mock('../../../src/store/queries.js', () => ({ getAllChains: vi.fn(() => []) }));

vi.mock('../../../src/sources/forkFeeds.js', () => ({ getForkMentions: vi.fn() }));
vi.mock('../../../src/sources/networkResearch.js', () => ({ getRepositoryChains: vi.fn(() => new Map()) }));

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
    getRepositoryChains.mockReturnValue(new Map());
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
    getRepositoryChains.mockReturnValue(new Map([['github:bnb-chain/bsc', [56, 97]]]));
    serveMentions([
      { ...event('bsc', { fork: fork({ name: 'Jenner', network: 'BSC Chapel Testnet', activationAt: '2099-10-29T02:30:00Z' }), affectedChains: ['BSC Chapel Testnet'], page: 'github:bnb-chain/bsc' }), feed: 'release' },
      // QuickNode's window names it the same way and joins it.
      { ...event('qn', { fork: fork({ name: 'Jenner', network: 'BSC Chapel Testnet', activationAt: '2099-10-29T02:30:00Z' }), affectedChains: ['BSC Chapel Testnet'] }), feed: 'status' }
    ]);
    expect((await getForks()).forks.find(f => f.name === 'Jenner').chains).toEqual([97]);
    expect((await getForks({ chainId: 56 })).forks).toHaveLength(0);
  });

  it('places "Morph Hoodi Testnet" on Morph\'s Hoodi, not Ethereum\'s', async () => {
    getAllChains.mockReturnValue(TESTNET_REGISTRY);
    serveMentions([
      { ...event('m', { fork: fork({ name: 'Celadon', network: 'Morph Hoodi Testnet', activationAt: '2099-10-28T06:00:00Z' }), affectedChains: ['Morph Hoodi Testnet'] }), feed: 'status' }
    ]);
    expect((await getForks()).forks.find(f => f.name === 'Celadon').chains).toEqual([2910]);
  });

  it('files a mainnet name under the mainnet, though the testnet shares it without "Testnet"', async () => {
    getAllChains.mockReturnValue(TESTNET_REGISTRY);
    serveMentions([
      { ...event('p', { fork: fork({ name: 'Pasteur', network: 'BNB Smart Chain', activationAt: '2099-08-25T02:30:00Z' }), affectedChains: ['BNB Smart Chain'] }), feed: 'news' }
    ]);
    expect((await getForks()).forks.find(f => f.name === 'Pasteur').chains).toEqual([56]);
  });

  it('places Morph\'s "Hoodi Testnet" release on Morph Hoodi, not Ethereum Hoodi', async () => {
    getAllChains.mockReturnValue(TESTNET_REGISTRY);
    getRepositoryChains.mockReturnValue(new Map([['github:morph-l2/morph', [2818, 2910]]]));
    serveMentions([
      { ...event('m', { fork: fork({ name: 'Celadon', network: 'Hoodi Testnet', activationAt: '2099-10-28T06:00:00Z' }), page: 'github:morph-l2/morph' }), feed: 'release' }
    ]);
    expect((await getForks()).forks.find(f => f.name === 'Celadon').chains).toEqual([2910]);
  });

  describe('placing a client release by its repository', () => {
    // Each on its own day: one activation shared across networks merges them into one fork.
    let day = 0;
    const release = (id, repo, network, name = 'F1') =>
      ({ ...event(id, { fork: fork({ name, network, activationAt: `2099-10-${String(++day).padStart(2, '0')}T02:30:00Z` }), page: repo }), feed: 'release' });
    const registry = [
      { chainId: 50, name: 'XDC Network', shortName: 'xdc' },
      { chainId: 51, name: 'XDC Apothem Network', shortName: 'txdc', tags: ['Testnet'] },
      { chainId: 102030, name: 'Creditcoin', shortName: 'ctc' },
      { chainId: 102031, name: 'Creditcoin Testnet', shortName: 'ctctest', tags: ['Testnet'] },
      { chainId: 102032, name: 'Creditcoin Devnet', shortName: 'ctcdev', tags: ['Testnet'] },
      { chainId: 4160, name: 'Algorand', shortName: 'algo' },
      { chainId: 5700, name: 'Syscoin Tanenbaum Testnet', shortName: 'tsys', tags: ['Testnet'] },
      { chainId: 57, name: 'Syscoin Mainnet', shortName: 'sys' },
      { chainId: 16, name: 'Songbird Testnet Coston', shortName: 'cflr', tags: ['Testnet'] },
      { chainId: 114, name: 'Flare Testnet Coston2', shortName: 'c2flr', tags: ['Testnet'] },
      { chainId: 42429, name: 'Tempo Testnet Andantino (Deprecated)', status: 'deprecated', tags: ['Testnet'] },
      { chainId: 42431, name: 'Tempo Testnet Moderato', tags: ['Testnet'] },
      { chainId: 4217, name: 'Tempo Mainnet' },
      { chainId: 96, name: 'KUB Mainnet', shortName: 'kub' },
      { chainId: 100000, name: 'QuarkChain Mainnet Root' },
      { chainId: 100001, name: 'QuarkChain Mainnet Shard 0' },
      { chainId: 100002, name: 'QuarkChain Mainnet Shard 1' },
      { chainId: 2039, name: 'Aleph Zero', shortName: 'aleph' },
      { chainId: 1, name: 'Ethereum Mainnet' },
      { chainId: 100, name: 'Gnosis' },
      { chainId: 11155111, name: 'Sepolia', tags: ['Testnet'] },
      { chainId: 560048, name: 'Ethereum Hoodi', tags: ['Testnet'] },
      { chainId: 17000, name: 'Ethereum Holesky', tags: ['Testnet'] },
      { chainId: 1666600000, name: 'Harmony Mainnet Shard 0', shortName: 'one', aliases: ['one'] },
      { chainId: 2810, name: 'Morph Hoodi', tags: ['Testnet'] },
      { chainId: 8453, name: 'Base' },
      { chainId: 84532, name: 'Base Sepolia Testnet', tags: ['Testnet'] },
      { chainId: 10, name: 'OP Mainnet' },
      // Enough unrelated ecosystems for "Mainnet", "Chain", "Network" to be learned as kind words.
      ...KIND_REGISTRY
    ];
    const repos = new Map([
      ['github:xinfinorg/xdposchain', [50, 51]],
      ['github:gluwa/creditcoin3', [102030, 102031, 102032]],
      ['github:algorand/go-algorand', [4160]],
      ['github:syscoin/syscoin', [57, 5700]],
      ['github:flare-foundation/go-flare', [16, 114]],
      ['github:tempoxyz/tempo', [4217, 42429, 42431]],
      ['github:kub-chain/bkc', [96]],
      ['github:quarkchain/goquarkchain', [100000, 100001, 100002]],
      ['github:sigp/lighthouse', [1, 100]],
      ['github:paradigmxyz/reth', [1, 11155111, 560048, 17000]],
      ['github:morph-l2/morph', [2810]],
      ['github:ethereum-optimism/optimism', [1, 8453, 10, 84532]]
    ]);
    const placed = async (...mentions) => {
      getAllChains.mockReturnValue(registry);
      getRepositoryChains.mockReturnValue(repos);
      serveMentions(mentions);
      return (await getForks({ limit: 200 })).forks;
    };
    const on = (forks, name) => forks.find(f => f.name === name)?.chains;

    it('picks the chain among the repository\'s that the release names, in its own words', async () => {
      const forks = await placed(
        release('a', 'github:xinfinorg/xdposchain', 'XDPoSChain Testnet', 'Prague'),
        release('b', 'github:gluwa/creditcoin3', 'Creditcoin3 Devnet', 'OsakaDev'),
        release('c', 'github:gluwa/creditcoin3', 'Creditcoin3 Testnet', 'OsakaTest'),
        release('d', 'github:syscoin/syscoin', 'Tanenbaum', 'Liberty'),
        release('e', 'github:flare-foundation/go-flare', 'Coston', 'GraniteC'),
        release('f', 'github:flare-foundation/go-flare', 'Coston2', 'GraniteC2'),
        release('g', 'github:kub-chain/bkc', 'Bitkub Chain', 'Erawan')
      );
      expect(on(forks, 'Prague')).toEqual([51]);
      expect(on(forks, 'OsakaDev')).toEqual([102032]);
      expect(on(forks, 'OsakaTest')).toEqual([102031]);
      expect(on(forks, 'Liberty')).toEqual([5700]);
      // The word itself over a longer one containing it.
      expect(on(forks, 'GraniteC')).toEqual([16]);
      expect(on(forks, 'GraniteC2')).toEqual([114]);
      expect(on(forks, 'Erawan')).toEqual([96]);
    });

    it('keeps a dated fork on the nearest chain rather than none', async () => {
      const forks = await placed(
        // A test network the repository does not run lands on its mainnet.
        release('a', 'github:algorand/go-algorand', 'Algorand Betanet', 'v43'),
        // Two testnets carry the name: the live one, not the deprecated one.
        release('b', 'github:tempoxyz/tempo', 'Tempo Testnet', 'T9'),
        // Naming no network, a release is about the client's mainnet: QuarkChain's root chain,
        // the fewest words over its shards.
        release('c', 'github:tempoxyz/tempo', null, 'T8'),
        release('e', 'github:quarkchain/goquarkchain', null, 'QRoot'),
        // A test network the registry does not list is filed under the network it tests.
        release('d', 'github:aleph-zero-foundation/aleph-node', 'Aleph Zero Testnet', 'A0')
      );
      expect(on(forks, 'v43')).toEqual([4160]);
      expect(on(forks, 'T9')).toEqual([42431]);
      expect(on(forks, 'T8')).toEqual([4217]);
      expect(on(forks, 'A0')).toEqual([2039]);
      expect(on(forks, 'QRoot')).toEqual([100000]);
    });

    it('leaves it unplaced, saying why, when nothing narrows it enough', async () => {
      const forks = await placed(
        // A client two mainnets run, its notes naming neither.
        release('a', 'github:sigp/lighthouse', null, 'Q1'),
        release('b', 'github:chainx-org/chainx', null, 'Rent'),
        { ...event('c', { fork: fork({ name: 'Protocol 30', activationAt: '2099-10-29T00:00:00Z' }), affectedChains: ['Stellar'], page: 'xlm' }) }
      );
      expect(forks.find(f => f.name === 'Q1')).toMatchObject({ chains: [], unplaced: { reason: 'ambiguous', repositories: ['github:sigp/lighthouse'] } });
      expect(forks.find(f => f.name === 'Q1').unplaced.candidates.map(c => c.chainId)).toEqual([1, 100]);
      expect(forks.find(f => f.name === 'Rent')).toMatchObject({ chains: [], unplaced: { reason: 'no_network_named', candidates: [] } });
      expect(forks.find(f => f.name === 'Protocol 30')).toMatchObject({ chains: [], unplaced: { reason: 'no_matching_chain', candidates: [] } });
    });

    it('guesses only for a project\'s own client, and never from another network\'s name', async () => {
      const forks = await placed(
        // A network none of a multi-network client's chains is called: no Sepolia or chain 1 fork.
        release('a', 'github:paradigmxyz/reth', 'Fusaka Devnet-3', 'FusakaD3'),
        // A test network named after another project's network is not that network.
        release('b', 'github:paradigmxyz/reth', 'One Testnet', 'OneT')
      );
      expect(forks.find(f => f.name === 'FusakaD3')).toMatchObject({ chains: [], unplaced: { reason: 'ambiguous' } });
      expect(on(forks, 'OneT')).toEqual([]);
    });

    it('folds a fork placed only by its repository into the one a name placed at that moment', async () => {
      const at = '2099-11-01T12:00:00Z';
      getAllChains.mockReturnValue(registry);
      getRepositoryChains.mockReturnValue(repos);
      serveMentions([
        { ...event('ef', { fork: fork({ name: 'Glamsterdam', network: 'Ethereum Hoodi', activationAt: at }), affectedChains: ['Ethereum Hoodi'], page: 'ef' }), feed: 'news' },
        // A rollup client's release of Ethereum's fork, in its own words.
        { ...event('m', { fork: fork({ name: 'Glamsterdam', network: 'Hoodi Testnet', activationAt: at }), page: 'github:morph-l2/morph' }), feed: 'release' }
      ]);
      const glam = (await getForks()).forks.filter(f => f.name === 'Glamsterdam');
      expect(glam).toHaveLength(1);
      expect(glam[0].chains).toEqual([560048]);
    });

    it('lets a repository guess yield to a name when an earlier merge joins them', async () => {
      const forks = await placed(
        // Unscoped: guessed onto Tempo mainnet by the repository alone.
        { ...event('a', { fork: fork({ name: 'T9', activationAt: '2099-11-05T15:00:00Z' }), page: 'github:tempoxyz/tempo' }), feed: 'release' },
        { ...event('b', { fork: fork({ name: 'T9', network: 'Tempo Testnet Moderato', activationAt: '2099-11-05T15:00:00Z' }), affectedChains: ['Tempo Testnet Moderato'], page: 'tempo' }), feed: 'news' }
      );
      const t9 = forks.filter(f => f.name === 'T9');
      expect(t9).toHaveLength(1);
      expect(t9[0].chains).toEqual([42431]);
    });

    it('lets a guess by kind alone yield to one by the network a release named', async () => {
      const at = '2099-11-06T15:00:00Z';
      const forks = await placed(
        { ...event('a', { fork: fork({ name: 'T13', network: 'Moderato Testnet', activationAt: at }), page: 'github:tempoxyz/tempo' }), url: 'https://example/v1.17.0#moderato', feed: 'release' },
        { ...event('b', { fork: fork({ name: 'T13', activationAt: at }), page: 'github:tempoxyz/tempo' }), url: 'https://example/v1.17.0', feed: 'release' }
      );
      const t13 = forks.filter(f => f.name === 'T13');
      expect(t13).toHaveLength(1);
      expect(t13[0].chains).toEqual([42431]);
    });

    it('keeps a bare "Testnet" for picking among the repository\'s chains', async () => {
      const forks = await placed(release('a', 'github:gluwa/creditcoin3', 'Testnet', 'OsakaBare'));
      expect(on(forks, 'OsakaBare')).toEqual([102031]);
    });

    it('takes the chains the client feed\'s model chose from the repository\'s networks first', async () => {
      const chose = (id, repo, network, name, chainIds) => {
        const m = release(id, repo, network, name);
        return { ...m, enrichment: { ...m.enrichment, fork: { ...m.enrichment.fork, chainIds } } };
      };
      const forks = await placed(
        // A Lighthouse release naming no network is ambiguous between 1 and 100 by words alone;
        // the model read the notes ("Mainnet release for Fusaka") with the repository's list.
        chose('a', 'github:sigp/lighthouse', null, 'Q2', [1]),
        chose('c', 'github:morph-l2/morph', 'Hoodi Testnet', 'Celadon', [2810]),
        // [] (the model could not tell) leaves the other evidence to decide.
        chose('b', 'github:gluwa/creditcoin3', 'Creditcoin3 Devnet', 'OsakaDev2', [])
      );
      expect(on(forks, 'Q2')).toEqual([1]);
      expect(on(forks, 'Celadon')).toEqual([2810]);
      expect(on(forks, 'OsakaDev2')).toEqual([102032]);
    });

    it('does not read a bare test qualifier as a network among a widely run client\'s chains', async () => {
      // "Testnet" matches Base Sepolia Testnet's name, but says nothing about Base: four chains run
      // this client, so a release naming no network of its own places nothing.
      const forks = await placed(
        release('a', 'github:ethereum-optimism/optimism', 'Testnet', 'OpBare'),
        release('b', 'github:ethereum-optimism/optimism', 'Fusaka Testnet', 'OpFusaka'),
        release('c', 'github:ethereum-optimism/optimism', 'Base Sepolia', 'OpBase')
      );
      expect(on(forks, 'OpBare')).toEqual([]);
      expect(on(forks, 'OpFusaka')).toEqual([]);
      expect(on(forks, 'OpBase')).toEqual([84532]);
    });

    it('serves the unplaced ones as a review queue', async () => {
      await placed(release('a', 'github:xinfinorg/xdposchain', 'XDPoSChain Testnet', 'Prague'), release('b', 'github:sigp/lighthouse', null, 'Q1'));
      const all = await getForks();
      expect(all.unplacedCount).toBe(1);
      expect(all.forks.find(f => f.name === 'Prague').unplaced).toBeUndefined();
      expect((await getForks({ unplaced: true })).forks.map(f => f.name)).toEqual(['Q1']);
    });
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
