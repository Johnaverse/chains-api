import { describe, it, expect, beforeAll } from 'vitest';
import {
  forkKey, forkScopes, normalizeForkName, resolveForkActivation, forkPhase,
  bestActivation, bestState, buildForks, FORK_PHASE, forkIdentity, scopeName, sourceRank,
  registryScopes, scopeLookups, forkKind, plausibleFork, observedAtOf, forksOf, isDateOnly, FORK_KIND
} from '../../../src/domain/forks.js';

import { learnNetworkWords } from '../../../src/domain/networkWords.js';
import { TESTNET_REGISTRY } from '../../fixtures/testnetRegistry.js';

const NOW = Date.parse('2026-08-14T12:00:00Z');

// Which words name test networks is learned from the registry, as in production.
beforeAll(() => learnNetworkWords(TESTNET_REGISTRY));

function event(id, { fork, chains = [8453], affectedChains, page = 'quicknode', publishedAt = '2026-08-14T00:00:00Z', updatedAt } = {}) {
  return {
    id, title: `t-${id}`, publishedAt, updatedAt: updatedAt ?? publishedAt,
    statusPage: { id: page }, chains: chains.map(chainId => ({ chainId })),
    enrichment: fork ? { fork, ...(affectedChains ? { affectedChains } : {}) } : {}
  };
}
const fork = (o = {}) => ({ name: null, activationAt: null, activationBlock: null, state: null, ...o });

describe('fork identity', () => {
  it('keys on the codename, however a source spells it', () => {
    // The point of the exercise: QuickNode writes "[Standard, Fork] … Protocol 28" and
    // Stellar's own page writes "Protocol 28 Upgrade Vote". Same fork, different sources.
    expect(forkKey(fork({ name: 'Protocol 28' }), 'stellar mainnet'))
      .toBe(forkKey(fork({ name: 'protocol-28' }), 'stellar mainnet'));
    expect(forkKey(fork({ name: 'PROTOCOL  28' }), 'stellar mainnet')).toBe('name:protocol 28@stellar mainnet');
  });

  it('does not merge forks that differ only by number', () => {
    expect(forkKey(fork({ name: 'Protocol 28' }), 'x')).not.toBe(forkKey(fork({ name: 'Protocol 29' }), 'x'));
  });

  it('does NOT merge the same codename across different networks', () => {
    // The bug this fixes, straight from live data: Protocol 28 activates on Stellar Testnet on
    // Aug 27 and on Mainnet on Sep 16. One key for both would have shown a single date, and
    // been wrong for at least one network without ever saying so.
    expect(forkKey(fork({ name: 'Protocol 28' }), 'stellar mainnet'))
      .not.toBe(forkKey(fork({ name: 'Protocol 28' }), 'stellar testnet'));
  });

  it('falls back to the height for a fork nobody named', () => {
    // The real Aleo case: marked "[Urgent, fork]", never named, pinned to height 18,813,000.
    expect(forkKey(fork({ activationBlock: 18813000 }), 'chain:1')).toBe('block:chain:1:18813000');
  });

  it('refuses a height with no network, since every chain reaches that height eventually', () => {
    expect(forkKey(fork({ activationBlock: 18813000 }), null)).toBeNull();
  });

  it('has no identity when the event names and pins nothing', () => {
    expect(forkKey(fork({ state: 'scheduled' }), 'chain:1')).toBeNull();
    expect(forkKey(null, 'chain:1')).toBeNull();
    expect(normalizeForkName('   ')).toBeNull();
  });

  it('scopes by the network the classifier named, qualifier included', () => {
    // affectedChains is the only network identity that survives for non-EVM chains — 171 live
    // events have no chainId, and every Stellar one has empty networkSlugs too.
    expect(forkScopes({ enrichment: { affectedChains: ['Stellar Mainnet', 'Stellar Testnet'] } }))
      .toEqual(['stellar', 'stellar testnet']);
  });

  it('falls back to chainId, then to a single unscoped bucket', () => {
    expect(forkScopes({ chains: [{ chainId: 8453 }] })).toEqual(['chain:8453']);
    expect(forkScopes({})).toEqual(['unscoped']);
  });
});

describe('activation resolution', () => {
  const tip = { height: 18800000, timestampMs: Date.parse('2026-08-14T12:00:00Z'), averageBlockSeconds: 10 };

  it('prefers a stated time over anything derived', () => {
    const out = resolveForkActivation(fork({ activationAt: '2026-08-25T03:00:00Z', activationBlock: 18813000 }), tip);
    expect(out).toMatchObject({ at: '2026-08-25T03:00:00.000Z', evidence: 'stated' });
  });

  it('estimates a future height from the tip and block rate', () => {
    // 13,000 blocks ahead at 10s each = 130,000s ≈ 1.5 days.
    const out = resolveForkActivation(fork({ activationBlock: 18813000 }), tip);
    expect(out.evidence).toBe('estimated');
    expect(Date.parse(out.at)).toBe(tip.timestampMs + 13000 * 10 * 1000);
  });

  it('labels a height already passed as observed, not estimated', () => {
    // The distinction matters for "upcoming -> past": a height behind the tip HAS happened,
    // and calling that an estimate would understate what is actually known.
    const out = resolveForkActivation(fork({ activationBlock: 18790000 }), tip);
    expect(out.evidence).toBe('observed');
    expect(Date.parse(out.at)).toBeLessThan(tip.timestampMs);
  });

  it('yields nothing rather than a guess when there is no tip', () => {
    expect(resolveForkActivation(fork({ activationBlock: 18813000 }), null)).toMatchObject({ at: null, evidence: null, block: 18813000 });
  });

  it('yields nothing when the explorer reports an unusable block rate', () => {
    expect(resolveForkActivation(fork({ activationBlock: 18813000 }), { ...tip, averageBlockSeconds: 0 }).at).toBeNull();
  });
});

describe('fork phase', () => {
  it('moves from upcoming to past once the activation is behind us', () => {
    expect(forkPhase({ activationAt: '2026-08-20T00:00:00Z' }, NOW)).toBe(FORK_PHASE.UPCOMING);
    expect(forkPhase({ activationAt: '2026-08-10T00:00:00Z' }, NOW)).toBe(FORK_PHASE.PAST);
  });

  it('keeps an undated fork out of the upcoming bucket', () => {
    // The calendar shows only forks whose timing is known; calling an undated one "upcoming"
    // would put it on a date it does not have.
    expect(forkPhase({ activationAt: null }, NOW)).toBe(FORK_PHASE.UNSCHEDULED);
  });

  it('reports cancelled whatever the date says', () => {
    expect(forkPhase({ activationAt: '2026-08-20T00:00:00Z', state: 'cancelled' }, NOW)).toBe(FORK_PHASE.CANCELLED);
    expect(forkPhase({ activationAt: '2026-08-10T00:00:00Z', state: 'cancelled' }, NOW)).toBe(FORK_PHASE.CANCELLED);
  });
});

describe('following a moving schedule', () => {
  it('lets a stated time beat a stronger-sounding but weaker estimate', () => {
    const chosen = bestActivation([
      { at: '2026-08-30T00:00:00Z', evidence: 'estimated', observedAt: 200 },
      { at: '2026-08-25T03:00:00Z', evidence: 'stated', observedAt: 100 }
    ]);
    expect(chosen.at).toBe('2026-08-25T03:00:00Z');
  });

  it('takes the newest claim when two are equally strong — that is a reschedule', () => {
    const chosen = bestActivation([
      { at: '2026-08-25T03:00:00Z', evidence: 'stated', observedAt: 100 },
      { at: '2026-08-28T03:00:00Z', evidence: 'stated', observedAt: 200 }
    ]);
    expect(chosen.at).toBe('2026-08-28T03:00:00Z');
  });

  it('does not let an older announcement resurrect a cancelled fork', () => {
    expect(bestState([
      { state: 'cancelled', observedAt: 100 },
      { state: 'scheduled', observedAt: 200 }
    ])).toBe('cancelled');
  });

  it('otherwise takes the most recent statement', () => {
    expect(bestState([
      { state: 'scheduled', observedAt: 100 },
      { state: 'rescheduled', observedAt: 200 }
    ])).toBe('rescheduled');
  });
});

describe('assembling forks from events', () => {
  it('joins one fork across independent status pages', async () => {
    // The live case this exists for: three events, two sources, one "Protocol 28".
    const events = [
      event('a', { fork: fork({ name: 'Protocol 28', activationAt: '2026-08-20T17:00:00Z' }), page: 'quicknode' }),
      event('b', { fork: fork({ name: 'protocol 28' }), page: 'xlm' }),
      event('c', { fork: fork({ name: 'Protocol 28' }), page: 'xlm' })
    ];
    const [forkOut] = await buildForks(events, { now: NOW });

    expect(forkOut.name).toBe('Protocol 28');
    expect(forkOut.sources.sort()).toEqual(['quicknode', 'xlm']);
    expect(forkOut.events).toHaveLength(3);
    expect(forkOut.phase).toBe(FORK_PHASE.UPCOMING);
  });

  it('joins one activation listed under several names and network spellings', async () => {
    // Live on 2026-10-19: Hoodi's 17:42:48 activation stood as five entries, Jenner as two.
    const hoodi = (id, name, network) => event(id, { chains: [560048], affectedChains: [network], fork: fork({ name, network, activationAt: '2026-10-26T17:42:48Z', state: 'scheduled' }) });
    const events = [
      hoodi('a', 'Glamsterdam', 'Ethereum Hoodi'), hoodi('b', 'Glamsterdam', 'Ethereum Hoodi'),
      hoodi('c', 'Gloas', 'Hoodi'), hoodi('d', 'Amsterdam', 'Hoodi'), hoodi('e', 'Glamsterdam', 'Hoodi')
    ];
    const chainIdsFor = () => [560048];
    const out = await buildForks(events, { now: NOW, chainIdsFor });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Glamsterdam', chains: [560048] });
    expect(out[0].aliases.sort()).toEqual(['Amsterdam', 'Gloas']);
    expect(out[0].events).toHaveLength(5);
    // What the timeline and latest release then know: the names resolve to the attested one.
    const { learnForkNames, canonicalForkId, _resetForkNamesForTests } = await import('../../../src/domain/forkNames.js');
    learnForkNames(out);
    expect([canonicalForkId('gloas'), canonicalForkId('amsterdam'), canonicalForkId('fusaka')]).toEqual(['glamsterdam', 'glamsterdam', 'fusaka']);
    _resetForkNamesForTests();
  });

  it('learns a bracket as an alias, unless it names a network, and keeps every alias one hop from the root', async () => {
    const { learnForkNames, canonicalForkId, _resetForkNamesForTests } = await import('../../../src/domain/forkNames.js');
    learnForkNames([
      { name: 'Glamsterdam/ePBS (Gloas)', aliases: ['Amsterdam'], events: [{}, {}] },
      { name: 'Fusaka (Hoodi)', events: [{}] }
    ]);
    expect([canonicalForkId('gloas'), canonicalForkId('amsterdam')]).toEqual(['glamsterdam', 'glamsterdam']);
    expect(canonicalForkId('hoodi')).toBe('hoodi');
    _resetForkNamesForTests();
  });

  it('joins a fork whose network resolved to no chain into the one placed fork at the same instant', async () => {
    // Live on 2026-10-23: a provider window put Glamsterdam on "Hoodi Testnet" (no chain), at the
    // exact second the placed Hoodi fork used; that fork was then cancelled, the stray stayed "upcoming".
    const placed = (id, state, publishedAt) => event(id, { chains: [560048], affectedChains: ['Ethereum Hoodi'], publishedAt, fork: fork({ name: 'Glamsterdam', network: 'Ethereum Hoodi', activationAt: '2026-10-26T17:42:48Z', state }) });
    const stray = event('w', { chains: [], affectedChains: ['Hoodi Testnet'], publishedAt: '2026-10-19T17:03:57Z', fork: fork({ name: 'Glamsterdam', network: 'Hoodi Testnet', activationAt: '2026-10-26T17:42:48Z', state: 'scheduled' }) });
    // A scope (the network as written) to chains: "Hoodi Testnet" resolves to none.
    const chainIdsFor = (scope) => (/ethereum hoodi/i.test(scope) ? [560048] : []);
    const out = await buildForks([placed('a', 'scheduled', '2026-10-16T00:00:00Z'), stray, placed('c', 'cancelled', '2026-10-22T20:00:00Z')], { now: NOW, chainIdsFor });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Glamsterdam', chains: [560048], phase: FORK_PHASE.CANCELLED });
    expect(out[0].events).toHaveLength(3);
  });

  it('leaves a fork with no chain apart when its instant matches two placed forks, or none', async () => {
    const at = (id, network, chains) => event(id, { chains, affectedChains: [network], fork: fork({ name: 'Celadon', network, activationAt: '2026-10-28T06:00:00Z', state: 'scheduled' }) });
    const chainIdsFor = (scope) => (/rollup a/i.test(scope) ? [1] : /rollup b/i.test(scope) ? [2] : []);
    const two = await buildForks([at('a', 'Rollup A Hoodi', [1]), at('b', 'Rollup B Hoodi', [2]), at('c', 'Hoodi Testnet', [])], { now: NOW, chainIdsFor });
    expect(two).toHaveLength(3);
    const day = await buildForks([at('a', 'Rollup A Hoodi', [1]), event('d', { chains: [], affectedChains: ['Hoodi Testnet'], fork: fork({ name: 'Celadon', network: 'Hoodi Testnet', activationAt: '2026-10-28', state: 'scheduled' }) })], { now: NOW, chainIdsFor });
    expect(day).toHaveLength(2);
  });

  it('keeps forks apart that share only a day, or only a time on other chains', async () => {
    const at = (id, name, activationAt, chains) => event(id, { chains, affectedChains: [name], fork: fork({ name, activationAt, state: 'scheduled' }) });
    const out = await buildForks([
      at('a', 'Alpha', '2026-11-03', [8453]), at('b', 'Beta', '2026-11-03', [8453]),
      at('c', 'Gamma', '2026-11-04T10:00:00Z', [10]), at('d', 'Delta', '2026-11-04T10:00:00Z', [8453])
    ], { now: NOW });
    expect(out.map(f => f.name).sort()).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
  });

  it('splits one codename into per-network forks with their own dates', async () => {
    // Reproduces the live Stellar data exactly. Protocol 28 reaches Testnet on Aug 27 and
    // Mainnet on Sep 16, while QuickNode runs ONE infrastructure window covering both. Before
    // this split, all three collapsed into a single fork with a single date — necessarily wrong
    // for one of the two networks, and wrong silently.
    const events = [
      event('qn', {
        fork: fork({ name: 'Protocol 28' }), page: 'quicknode', chains: [],
        affectedChains: ['Stellar Mainnet', 'Stellar Testnet'], updatedAt: '2026-08-14T13:45:00Z'
      }),
      event('main', {
        fork: fork({ name: 'Protocol 28', activationAt: '2026-09-16T17:00:00Z' }), page: 'xlm', chains: [],
        affectedChains: ['Stellar Mainnet'], updatedAt: '2026-08-13T19:23:00Z'
      }),
      event('test', {
        fork: fork({ name: 'Protocol 28', activationAt: '2026-08-27T17:00:00Z' }), page: 'xlm', chains: [],
        affectedChains: ['Stellar Testnet'], updatedAt: '2026-08-13T19:20:00Z'
      })
    ];

    const out = await buildForks(events, { now: NOW });

    expect(out).toHaveLength(2);
    const testnet = out.find(f => f.network === 'stellar testnet');
    const mainnet = out.find(f => f.network === 'stellar');
    expect(testnet.activationAt).toBe('2026-08-27T17:00:00.000Z');
    expect(mainnet.activationAt).toBe('2026-09-16T17:00:00.000Z');
    // And the cross-provider join still fires: QuickNode's combined window contributes to both.
    expect(testnet.sources.sort()).toEqual(['quicknode', 'xlm']);
    expect(mainnet.sources.sort()).toEqual(['quicknode', 'xlm']);
  });

  it('never groups events that carry no fork identity', async () => {
    // A wrong grouping is worse than none — it would attribute one network's upgrade to
    // another's window. Checked against the feed: chain+time proximity produced only false
    // pairs, so proximity is deliberately not a fallback.
    const events = [event('a'), event('b', { fork: fork({ state: 'scheduled' }) })];
    expect(await buildForks(events, { now: NOW })).toEqual([]);
  });

  it('converts a height-only fork using the chain tip', async () => {
    const events = [event('a', { fork: fork({ activationBlock: 18813000 }), chains: [1] })];
    const tipFor = async () => ({ height: 18800000, timestampMs: NOW, averageBlockSeconds: 10 });

    const [forkOut] = await buildForks(events, { now: NOW, tipFor });

    expect(forkOut.activationEvidence).toBe('estimated');
    expect(forkOut.activationBlock).toBe(18813000);
    expect(forkOut.phase).toBe(FORK_PHASE.UPCOMING);
  });

  it('does not call the explorer when every activation is already stated', async () => {
    // The common case; a fork with a real time should cost no network round trip.
    let calls = 0;
    const events = [event('a', { fork: fork({ name: 'Rex6', activationAt: '2026-08-25T03:00:00Z' }) })];
    await buildForks(events, { now: NOW, tipFor: async () => { calls += 1; return null; } });
    expect(calls).toBe(0);
  });

  it('still reports a height-only fork when the explorer is unavailable', async () => {
    const events = [event('a', { fork: fork({ activationBlock: 18813000 }), chains: [1] })];
    const [forkOut] = await buildForks(events, { now: NOW, tipFor: async () => null });

    expect(forkOut.activationAt).toBeNull();
    expect(forkOut.phase).toBe(FORK_PHASE.UNSCHEDULED);
    expect(forkOut.activationBlock).toBe(18813000);   // the fact survives
  });

  it('orders upcoming first, then undated, then cancelled, then history', async () => {
    const events = [
      event('past', { fork: fork({ name: 'old', activationAt: '2026-08-01T00:00:00Z' }) }),
      event('soon', { fork: fork({ name: 'soon', activationAt: '2026-08-16T00:00:00Z' }) }),
      event('later', { fork: fork({ name: 'later', activationAt: '2026-08-25T00:00:00Z' }) }),
      event('undated', { fork: fork({ name: 'undated' }) }),
      event('off', { fork: fork({ name: 'off', activationAt: '2026-08-18T00:00:00Z', state: 'cancelled' }) })
    ];
    const out = await buildForks(events, { now: NOW });
    expect(out.map(f => f.name)).toEqual(['soon', 'later', 'undated', 'off', 'old']);
  });

  it('follows a reschedule announced later by a different source', async () => {
    const events = [
      // Ordered by publication: updatedAt is not trusted (QuickNode sets it to the window start).
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2026-08-25T03:00:00Z' }), page: 'quicknode', publishedAt: '2026-08-10T00:00:00Z' }),
      event('b', { fork: fork({ name: 'Rex6', activationAt: '2026-08-28T03:00:00Z', state: 'rescheduled' }), page: 'megaeth', publishedAt: '2026-08-13T00:00:00Z' })
    ];
    const [forkOut] = await buildForks(events, { now: NOW });

    expect(forkOut.activationAt).toBe('2026-08-28T03:00:00.000Z');
    expect(forkOut.state).toBe('rescheduled');
    expect(forkOut.phase).toBe(FORK_PHASE.UPCOMING);
  });
});

describe('forks across status, forum and news feeds', () => {
  // A mention from chains-forum-news or chains-news, in the shape src/sources/forkFeeds.js builds.
  const mention = (id, feed, f, { affectedChains = [], weight = null, page = id, kind, publishedAt = '2026-09-28T00:00:00Z', chains = [] } = {}) => ({
    id, feed, title: `t-${id}`, publishedAt, updatedAt: publishedAt, weight,
    statusPage: { id: page, kind: kind ?? feed }, chains,
    enrichment: { affectedChains, fork: fork(f) }
  });

  it('treats "Glamsterdam", "the Glamsterdam upgrade" and "Glamsterdam hard fork" as one name', () => {
    expect(forkIdentity('the Glamsterdam upgrade')).toBe('glamsterdam');
    expect(forkIdentity('Glamsterdam hard fork')).toBe('glamsterdam');
    expect(forkIdentity('Protocol 28')).toBe('protocol 28');
    // A name made only of generic words identifies nothing, so it is no name at all: "Protocol
    // Upgrade" must not collapse to "protocol" and merge two unrelated notices under it.
    expect(forkIdentity('Upgrade')).toBeNull();
    expect(forkIdentity('Protocol Upgrade')).toBeNull();
    expect(forkIdentity('Network Upgrade')).toBeNull();
    expect(forkIdentity('the hard fork')).toBeNull();
    expect(forkIdentity('Network Upgrade 5')).toBe('network upgrade 5');
  });

  it('drops only the mainnet qualifier from a scope', () => {
    expect(scopeName('Ethereum Mainnet')).toBe(scopeName('Ethereum'));
    expect(scopeName('Ethereum Sepolia')).toBe('ethereum sepolia');
  });

  it('scopes by the network that forks, not by what the post is about', () => {
    // Arbitrum's governance post adjusts Arbitrum for Ethereum's fork.
    const post = mention('arb', 'forum', { name: 'Glamsterdam', network: 'Ethereum' }, { affectedChains: ['Arbitrum One', 'Arbitrum Nova'] });
    expect(forkScopes(post)).toEqual(['ethereum']);
  });

  it('keeps an unnamed fork that only states an exact time', () => {
    expect(forkKey(fork({ activationAt: '2026-10-06T13:53:36Z' }), 'ethereum sepolia'))
      .toBe('at:ethereum sepolia:2026-10-06T13:53:36.000Z');
  });

  it('merges the unnamed provider notice into the named announcement at the same instant', async () => {
    // Live case: Alchemy never names the Sepolia fork; the EF post names it and states the same second.
    const out = await buildForks([
      { ...event('alchemy', { fork: fork({ activationAt: '2026-10-06T13:53:36Z', state: 'scheduled' }), affectedChains: ['Ethereum Sepolia'], page: 'alchemy' }), feed: 'status' },
      mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: '2026-10-06T13:53:36Z', state: 'scheduled' }, { weight: 'primary', page: 'ethereum-foundation' })
    ], { now: Date.parse('2026-10-01T00:00:00Z') });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'Glamsterdam', network: 'ethereum sepolia', activationAt: '2026-10-06T13:53:36.000Z', phase: FORK_PHASE.UPCOMING });
    expect(out[0].sources.sort()).toEqual(['alchemy', 'ethereum-foundation']);
    expect(out[0].feeds.sort()).toEqual(['news', 'status']);
  });

  it('never folds an unnamed fork when two named forks share its instant', async () => {
    const at = '2026-10-06T13:53:36Z';
    const out = await buildForks([
      { ...event('p', { fork: fork({ activationAt: at }), affectedChains: ['X'] }), feed: 'status' },
      mention('a', 'forum', { name: 'Alpha', network: 'X', activationAt: at }),
      mention('b', 'forum', { name: 'Beta', network: 'X', activationAt: at })
    ], { now: NOW });
    expect(out).toHaveLength(3);
  });

  it('does not let a secondary outlet override the network\'s own date', async () => {
    const out = await buildForks([
      mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum', activationAt: '2099-12-03T00:00:00Z' }, { weight: 'primary', publishedAt: '2026-10-01T00:00:00Z' }),
      // Newer, but a report of someone else's plan.
      mention('wire', 'news', { name: 'Glamsterdam', network: 'Ethereum', activationAt: '2099-12-10T00:00:00Z' }, { weight: 'secondary', publishedAt: '2026-10-05T00:00:00Z' })
    ], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].activationAt).toBe('2099-12-03T00:00:00.000Z');
  });

  it('ranks sources: network and primary first, provider windows next, secondary news last', () => {
    expect(sourceRank({ feed: 'status', statusPage: { kind: 'chain' } })).toBe(0);
    expect(sourceRank({ feed: 'forum' })).toBe(0);
    expect(sourceRank({ feed: 'news', weight: 'primary' })).toBe(0);
    expect(sourceRank({ feed: 'status', statusPage: { kind: 'rpc-provider' } })).toBe(1);
    expect(sourceRank({ feed: 'news', weight: 'secondary' })).toBe(2);
  });
  it('takes the forking network\'s chains, not the poster\'s, when the source named it', async () => {
    // Review #184: an Arbitrum post about Ethereum's fork declared 42161, which converted an
    // Ethereum height with Arbitrum's tip and listed Glamsterdam under ?chainId=42161.
    const arb = { ...mention('arb', 'forum', { name: 'Glamsterdam', network: 'Ethereum', activationBlock: 25000000 }, { affectedChains: ['Arbitrum One'] }), chains: [{ chainId: 42161 }] };
    const looked = [];
    const tipFor = async (id) => { looked.push(id); return { height: 24000000, timestampMs: NOW, averageBlockSeconds: 12 }; };
    const out = await buildForks([arb], { tipFor, chainIdsFor: (scope) => (scope === 'ethereum' ? [1] : []), now: NOW });
    expect(out[0].chains).toEqual([1]);
    expect(looked).toEqual([1]);
    // Without a resolver the poster's chains are still not borrowed.
    const bare = await buildForks([arb], { tipFor, now: NOW });
    expect(bare[0].chains).toEqual([]);
  });

  it('keeps the post\'s chains when the post is about the forking network', async () => {
    const ef = { ...mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum' }, { affectedChains: ['Ethereum Mainnet'] }), chains: [{ chainId: 1 }] };
    const out = await buildForks([ef], { now: NOW });
    expect(out[0].chains).toEqual([1]);
  });

  it('lends a post\'s chains to a network the registry cannot resolve only when the chain carries its name', async () => {
    const names = { 1: ['Ethereum Mainnet', 'mainnet'], 2910: ['Morph Hoodi Testnet', 'morph-hoodi'] };
    const opts = { now: Date.parse('2026-08-22T00:00:00Z'), chainIdsFor: () => [], chainNamesFor: (id) => names[id] ?? [] };
    // Decrypt on Solana's Alpenglow "since Ethereum's Merge" declares chain 1; Solana has no EVM chain.
    const alpenglow = await buildForks([
      { ...mention('decrypt', 'news', { name: 'Alpenglow', network: 'Solana' }, { affectedChains: ['Solana'] }), chains: [{ chainId: 1 }] }
    ], opts);
    expect(alpenglow[0].chains).toEqual([]);
    // QuickNode's Morph window on "Hoodi Testnet" declares 2910, whose own name says so.
    const celadon = await buildForks([
      mention('qn', 'status', { name: 'Celadon', network: 'Hoodi Testnet', activationAt: '2099-10-28T05:00:00Z' }, { chains: [{ chainId: 2910 }], affectedChains: ['Hoodi Testnet'] })
    ], opts);
    expect(celadon[0].chains).toEqual([2910]);
  });

  it('keeps a multi-network window on the test network the fork network names alongside', () => {
    // fork.network narrows the scopes; it must not drop "Stellar Testnet" from a window covering both.
    const window = mention('qn', 'status', { name: 'Protocol 28', network: 'Stellar Mainnet' }, { affectedChains: ['Stellar Mainnet', 'Stellar Testnet'] });
    expect(forkScopes(window)).toEqual(['stellar', 'stellar testnet']);
    // A longer name that is a different network is not a test network of it.
    const etc = mention('etc', 'forum', { name: 'Olympia', network: 'Ethereum Classic' }, { affectedChains: ['Ethereum Classic', 'Ethereum'] });
    expect(forkScopes(etc)).toEqual(['ethereum classic']);
  });

  it('keeps the network\'s own date when provider windows say another: a provider window is the provider\'s schedule', async () => {
    const out = await buildForks([
      mention('page', 'status', { name: 'Protocol 30', network: 'X', activationAt: '2099-09-01T00:00:00Z' }, { kind: 'chain', publishedAt: '2026-08-01T00:00:00Z' }),
      mention('qn', 'status', { name: 'Protocol 30', network: 'X', activationAt: '2099-09-15T00:00:00Z' }, { kind: 'rpc-provider', publishedAt: '2026-08-20T00:00:00Z' }),
      mention('alc', 'status', { name: 'Protocol 30', network: 'X', activationAt: '2099-09-15T01:00:00Z' }, { kind: 'rpc-provider', publishedAt: '2026-08-21T00:00:00Z' })
    ], { now: Date.parse('2026-08-22T00:00:00Z') });   // observed times are clamped to now
    expect(out).toHaveLength(1);
    expect(out[0].activationAt).toBe('2099-09-01T00:00:00.000Z');
    // The windows stay listed: they say when each provider upgrades.
    expect(out[0].events).toHaveLength(3);
    expect(out[0].sources.sort()).toEqual(['alc', 'page', 'qn']);
  });

  it('takes the chain from a provider window only when the network\'s own sources name none', async () => {
    const out = await buildForks([
      mention('rel', 'release', { name: 'Celadon', network: 'Hoodi Testnet', activationAt: '2099-10-28T06:00:00Z' }, { chains: [] }),
      mention('qn', 'status', { name: 'Celadon', network: 'Hoodi Testnet', activationAt: '2099-10-28T05:00:00Z' }, { kind: 'rpc-provider', chains: [{ chainId: 2910 }], affectedChains: ['Hoodi Testnet'] })
    ], { now: Date.parse('2026-08-22T00:00:00Z') });
    expect(out).toHaveLength(1);
    expect(out[0].chains).toEqual([2910]);
    // ...and still never the time: the release's, not the window's hour earlier.
    expect(out[0].activationAt).toBe('2099-10-28T06:00:00.000Z');
  });

  it('lists no fork that only providers mention: their windows are their maintenance', async () => {
    const out = await buildForks([
      mention('qn', 'status', { name: 'Protocol 31', network: 'X', activationAt: '2099-10-01T00:00:00Z' }, { kind: 'rpc-provider' }),
      mention('alc', 'status', { name: 'Protocol 31', network: 'X', activationAt: '2099-10-01T00:00:00Z' }, { kind: 'rpc-provider' })
    ], { now: Date.parse('2026-08-22T00:00:00Z') });
    expect(out).toEqual([]);
  });

  it('does not treat a provider window a few hours early as a reschedule', () => {
    const best = bestActivation([
      { at: '2099-10-06T13:53:36.000Z', evidence: 'stated', rank: 0, observedAt: 1 },
      { at: '2099-10-06T12:00:00.000Z', evidence: 'stated', rank: 1, observedAt: 2 }
    ]);
    expect(best.at).toBe('2099-10-06T13:53:36.000Z');
  });

  it('clusters unnamed provider windows a few hours apart into the named fork', async () => {
    const out = await buildForks([
      { ...event('a', { fork: fork({ activationAt: '2026-10-06T13:00:00Z' }), affectedChains: ['Ethereum Sepolia'], page: 'a' }), feed: 'status' },
      { ...event('b', { fork: fork({ activationAt: '2026-10-06T13:30:00Z' }), affectedChains: ['Ethereum Sepolia'], page: 'b' }), feed: 'status' },
      mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum Sepolia', activationAt: '2026-10-06T13:53:36Z' }, { weight: 'primary', page: 'ef' })
    ], { now: Date.parse('2026-10-01T00:00:00Z') });
    expect(out).toHaveLength(1);
    expect(out[0].sources.sort()).toEqual(['a', 'b', 'ef']);
    expect(out[0].activationAt).toBe('2026-10-06T13:53:36.000Z');
  });

  it('joins an unnamed height notice and an unnamed time notice for one activation', async () => {
    const out = await buildForks([
      event('h', { fork: fork({ activationBlock: 18813000, activationAt: '2026-08-18T10:00:00Z' }), affectedChains: ['Aleo'], page: 'h' }),
      event('t', { fork: fork({ activationAt: '2026-08-18T09:30:00Z' }), affectedChains: ['Aleo'], page: 't' })
    ], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].activationBlock).toBe(18813000);
  });

  it('keeps unnamed notices days apart as separate forks', async () => {
    const out = await buildForks([
      event('a', { fork: fork({ activationAt: '2026-08-18T10:00:00Z' }), affectedChains: ['Aleo'] }),
      event('b', { fork: fork({ activationAt: '2026-09-18T10:00:00Z' }), affectedChains: ['Aleo'] })
    ], { now: NOW });
    expect(out).toHaveLength(2);
  });

  it('joins a chainId-scoped mention with the same fork scoped by network name', async () => {
    const forum = { ...mention('forum', 'forum', { name: 'Glamsterdam' }), chains: [{ chainId: 1 }] };
    const ef = { ...mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum' }, { affectedChains: ['Ethereum'] }), chains: [{ chainId: 1 }] };
    const out = await buildForks([forum, ef], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].network).toBe('ethereum');
    expect(out[0].sources.sort()).toEqual(['ef', 'forum']);
  });

  it('groups generic-named notices by their timing, not by the generic name', async () => {
    const out = await buildForks([
      event('a', { fork: fork({ name: 'Network Upgrade', activationAt: '2026-08-18T10:00:00Z' }), affectedChains: ['X'] }),
      event('b', { fork: fork({ name: 'Protocol Upgrade', activationAt: '2026-11-02T10:00:00Z' }), affectedChains: ['X'] })
    ], { now: NOW });
    expect(out).toHaveLength(2);
  });
  it('ranks a post from another network about the fork as indirect, not as the network\'s own', async () => {
    // Copilot on #184: Arbitrum's forum thread on Ethereum's Glamsterdam tied Ethereum's own date.
    const arb = mention('arb', 'forum', { name: 'Glamsterdam', network: 'Ethereum' }, { affectedChains: ['Arbitrum One'] });
    expect(sourceRank(arb)).toBe(2);
    const own = mention('eth', 'forum', { name: 'Glamsterdam', network: 'Ethereum' }, { affectedChains: ['Ethereum'] });
    expect(sourceRank(own)).toBe(0);
    const out = await buildForks([
      mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum', activationAt: '2099-12-03T00:00:00Z' }, { weight: 'primary', affectedChains: ['Ethereum'], publishedAt: '2026-10-01T00:00:00Z' }),
      mention('arb', 'forum', { name: 'Glamsterdam', network: 'Ethereum', activationAt: '2099-12-20T00:00:00Z' }, { affectedChains: ['Arbitrum One'], publishedAt: '2026-10-05T00:00:00Z' })
    ], { now: NOW });
    expect(out[0].activationAt).toBe('2099-12-03T00:00:00.000Z');
  });

  it('never lends a mainnet chain to a test-network activation', async () => {
    // Copilot on #184: fork.network "Ethereum Sepolia" with affectedChains ["Ethereum"] and chain 1.
    const item = { ...mention('ef', 'news', { name: 'Glamsterdam', network: 'Ethereum Sepolia' }, { affectedChains: ['Ethereum'] }), chains: [{ chainId: 1 }] };
    const out = await buildForks([item], { now: NOW });
    expect(out[0]).toMatchObject({ network: 'ethereum sepolia', chains: [] });
  });

  it('looks a qualified test network up by its registry name too', () => {
    expect(scopeLookups('ethereum sepolia')).toEqual(['ethereum sepolia', 'sepolia']);
    expect(scopeLookups('ethereum classic')).toEqual(['ethereum classic']);
    // BSC's Jenner on "BSC Chapel Testnet": the registry has chain 97 as "chapel".
    expect(scopeLookups('bsc chapel testnet')).toEqual(['bsc chapel testnet', 'chapel testnet', 'chapel']);
    expect(scopeLookups('arbitrum one testnet')).not.toContain('one');
    expect(registryScopes('Base Sepolia Testnet')).toEqual(['base sepolia testnet', 'base sepolia']);
    expect(registryScopes('Ethereum Mainnet')).toEqual(['ethereum']);
  });
});

describe('fork review fixes', () => {
  const cls = (e, c) => ({ ...e, enrichment: { ...e.enrichment, class: c } });

  describe('fork vs ordinary software update (kind)', () => {
    const member = (f, c) => ({ fork: fork(f), event: { enrichment: { class: c } } });

    it('treats a planned_software_update with no date as an upgrade, not a fork', async () => {
      // Live: Nanoreth, a v29.0.1 RPC patch named "Protocol 29", Celestia "Fibre server setup".
      const out = await buildForks([
        cls(event('n', { fork: fork({ name: 'Nanoreth' }), affectedChains: ['HyperEVM'] }), 'planned_software_update'),
        cls(event('p', { fork: fork({ name: 'Protocol 29' }), affectedChains: ['Stellar'] }), 'planned_software_update')
      ], { now: NOW });
      expect(out.map(f => f.kind)).toEqual(['upgrade', 'upgrade']);
    });

    it('keeps a hard-fork-classed group a fork, whatever the other members are', async () => {
      const out = await buildForks([
        cls(event('a', { fork: fork({ name: 'Glamsterdam' }), affectedChains: ['Ethereum'] }), 'planned_software_update'),
        cls(event('b', { fork: fork({ name: 'Glamsterdam' }), affectedChains: ['Ethereum'] }), 'planned_hard_fork')
      ], { now: NOW });
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe(FORK_KIND.FORK);
    });

    it('counts a named, dated network upgrade as a fork even when only provider windows report it', async () => {
      // Stellar "Protocol 28" reaches the feed mostly as provider windows classed as software updates.
      const out = await buildForks([
        cls(event('qn', { fork: fork({ name: 'Protocol 28', activationAt: '2026-09-16T17:00:00Z' }), affectedChains: ['Stellar Mainnet'] }), 'planned_software_update')
      ], { now: NOW });
      expect(out[0].kind).toBe('fork');
    });

    it('applies the rule: version names and undated names are upgrades; heights are forks', () => {
      const stated = { evidence: 'stated' };
      expect(forkKind([member({ name: 'v29.0.1', activationAt: '2026-09-01T00:00:00Z' }, 'planned_software_update')], stated)).toBe('upgrade');
      expect(forkKind([member({ name: 'Sui testnet v1.58.2', activationAt: '2026-09-01T00:00:00Z' }, 'planned_software_update')], stated)).toBe('upgrade');
      expect(forkKind([member({ name: 'Rex6' }, 'planned_software_update')], null)).toBe('upgrade');
      expect(forkKind([member({ name: 'Rex6' }, 'planned_software_update')], stated)).toBe('fork');
      expect(forkKind([member({ activationBlock: 18813000 }, 'planned_software_update')], null)).toBe('fork');
      expect(forkKind([member({ name: 'X' }, 'hard_fork')], null)).toBe('fork');   // legacy class
      // No class anywhere: nothing to judge on, so it stays a fork.
      expect(forkKind([member({ name: 'X' }, undefined)], null)).toBe('fork');
    });
  });

  describe('implausible stated dates', () => {
    it('drops a stated activation far before the post that states it', async () => {
      // Alpenglow, announced in 2026, came back dated 2024-10-21: the model guessed the year.
      const out = await buildForks([
        event('a', { fork: fork({ name: 'Alpenglow', activationAt: '2024-10-21T00:00:00Z' }), affectedChains: ['Solana'], publishedAt: '2026-08-01T00:00:00Z' })
      ], { now: NOW });
      expect(out[0]).toMatchObject({ activationAt: null, phase: FORK_PHASE.UNSCHEDULED });
      expect(out[0].events[0].enrichment.fork).toMatchObject({ activationAt: null, implausibleActivationAt: '2024-10-21T00:00:00Z' });
    });

    it('keeps a recent past date and a completed retrospective', () => {
      const published = Date.parse('2026-08-01T00:00:00Z');
      expect(plausibleFork(fork({ activationAt: '2026-07-20T00:00:00Z' }), published).activationAt).toBe('2026-07-20T00:00:00Z');
      expect(plausibleFork(fork({ activationAt: '2024-10-21T00:00:00Z', state: 'completed' }), published).activationAt).toBe('2024-10-21T00:00:00Z');
      expect(plausibleFork(fork({ activationAt: '2024-10-21T00:00:00Z' }), published).activationAt).toBeNull();
    });
  });

  describe('when a claim was made', () => {
    it('ignores updatedAt, prefers enrichment.createdAt, and never lies in the future', () => {
      const now = Date.parse('2026-08-14T12:00:00Z');
      // QuickNode sets updatedAt to the window start, in the future.
      expect(observedAtOf({ publishedAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }, now)).toBe(Date.parse('2026-08-01T00:00:00Z'));
      expect(observedAtOf({ publishedAt: '2026-08-01T00:00:00Z', enrichment: { createdAt: '2026-08-02T00:00:00Z' } }, now)).toBe(Date.parse('2026-08-02T00:00:00Z'));
      expect(observedAtOf({ publishedAt: '2026-09-01T00:00:00Z' }, now)).toBe(now);
      expect(observedAtOf({}, now)).toBe(0);
    });

    it('does not let a future updatedAt pass for a reschedule', async () => {
      const out = await buildForks([
        event('net', { fork: fork({ name: 'Rex6', activationAt: '2026-08-25T03:00:00Z' }), page: 'megaeth', publishedAt: '2026-08-12T00:00:00Z' }),
        // Older notice whose updatedAt is its (future) window start.
        { ...event('qn', { fork: fork({ name: 'Rex6', activationAt: '2026-08-20T00:00:00Z' }), page: 'quicknode', publishedAt: '2026-08-01T00:00:00Z' }), updatedAt: '2026-08-20T00:00:00Z' }
      ], { now: NOW });
      expect(out[0].activationAt).toBe('2026-08-25T03:00:00.000Z');
    });
  });

  it('puts a completed fork with no date in the past, not unscheduled', async () => {
    // dYdX v9.8.0: reported done, never dated.
    expect(forkPhase({ activationAt: null, state: 'completed' }, NOW)).toBe(FORK_PHASE.PAST);
    const out = await buildForks([event('d', { fork: fork({ name: 'v9.8.0', state: 'completed' }), affectedChains: ['dYdX'] })], { now: NOW });
    expect(out[0].phase).toBe(FORK_PHASE.PAST);
  });

  it('collapses one window naming several networks into a single entry', async () => {
    // Nanoreth ×3: one window, three networks, identical evidence.
    const out = await buildForks([
      event('w', { fork: fork({ name: 'Nanoreth' }), affectedChains: ['HyperEVM', 'HyperEVM Testnet', 'Hyperliquid'], chains: [] })
    ], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].networks).toEqual(['hyperevm', 'hyperevm testnet', 'hyperliquid']);
    expect(out[0].events).toHaveLength(1);
  });

  it('does not collapse two forks one post names, nor networks with evidence of their own', async () => {
    const both = event('both', { fork: fork({ name: 'Protocol 28' }), affectedChains: ['Stellar Mainnet', 'Stellar Testnet'], chains: [] });
    const own = event('own', { fork: fork({ name: 'Protocol 28', activationAt: '2026-08-27T17:00:00Z' }), affectedChains: ['Stellar Testnet'], chains: [] });
    expect(await buildForks([both, own], { now: NOW })).toHaveLength(2);
    const a = { ...event('p', { fork: fork({ name: 'Alpha' }), affectedChains: ['X'] }), url: 'https://x/post' };
    const b = { ...a, enrichment: { ...a.enrichment, fork: fork({ name: 'Beta' }) } };
    expect(await buildForks([a, b], { now: NOW })).toHaveLength(2);
  });

  it('keeps per-network dates from one post apart instead of collapsing them', async () => {
    // One EF post, one name, Sepolia and Hoodi on different days: every event is shared, the
    // claims are not, so collapsing would silently drop one network's date.
    // The feed reader turns its `forks` array into one mention per entry, all with one URL.
    const mention = (network, activationAt) => ({
      ...event('ef', { fork: fork({ name: 'Glamsterdam', network, activationAt }), chains: [] }),
      url: 'https://blog.ethereum.org/glamsterdam-testnets'
    });
    const posts = [mention('Ethereum Sepolia', '2026-10-21T14:00:00Z'), mention('Ethereum Hoodi', '2026-11-04T14:00:00Z')];
    const out = await buildForks(posts, { now: NOW });
    expect(out).toHaveLength(2);
    expect(out.map(f => f.activationAt).sort()).toEqual(['2026-10-21T14:00:00.000Z', '2026-11-04T14:00:00.000Z']);
  });

  it('anchors unnamed clusters to their first time instead of chaining them', async () => {
    // Single linkage strung notices 5h apart into one 30h fork.
    const times = ['2026-08-18T00:00:00Z', '2026-08-18T05:00:00Z', '2026-08-18T10:00:00Z', '2026-08-18T15:00:00Z'];
    const out = await buildForks(times.map((t, i) => event(`n${i}`, { fork: fork({ activationAt: t }), affectedChains: ['Aleo'], page: `p${i}` })), { now: NOW });
    expect(out).toHaveLength(2);
    expect(out.map(f => f.events.length).sort()).toEqual([2, 2]);
  });

  it('folds an unscoped named mention into the one network-scoped fork of that name', async () => {
    const out = await buildForks([
      event('net', { fork: fork({ name: 'Glamsterdam', activationAt: '2026-12-03T00:00:00Z' }), affectedChains: ['Ethereum'], chains: [] }),
      event('loose', { fork: fork({ name: 'the Glamsterdam upgrade' }), chains: [] })
    ], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].events).toHaveLength(2);
    // Two candidates: ambiguous, left alone.
    const two = await buildForks([
      event('m', { fork: fork({ name: 'Z' }), affectedChains: ['A'], chains: [] }),
      event('t', { fork: fork({ name: 'Z' }), affectedChains: ['B'], chains: [] }),
      event('u', { fork: fork({ name: 'Z' }), chains: [] })
    ], { now: NOW });
    expect(two).toHaveLength(3);
  });

  it('lists each event URL once within a fork', async () => {
    const copy = (i, publishedAt) => ({ ...event(`c${i}`, { fork: fork({ name: 'v9.8.0', state: 'completed' }), affectedChains: ['dYdX'], publishedAt }), url: 'https://dydx/post' });
    const out = await buildForks([copy(1, '2026-08-01T00:00:00Z'), copy(2, '2026-08-03T00:00:00Z'), copy(3, '2026-08-02T00:00:00Z')], { now: NOW });
    expect(out[0].events).toHaveLength(1);
    expect(out[0].events[0].id).toBe('c2');   // the newest copy
  });

  describe('date-only activations', () => {
    it('marks the precision and keeps the day upcoming until it is over', async () => {
      expect(isDateOnly('2026-08-14')).toBe(true);
      expect(isDateOnly('2026-08-14T00:00:00Z')).toBe(false);
      const out = await buildForks([event('d', { fork: fork({ name: 'Rex7', activationAt: '2026-08-14' }), affectedChains: ['MegaETH'] })], { now: NOW });
      expect(out[0]).toMatchObject({ activationPrecision: 'day', phase: FORK_PHASE.UPCOMING });
      expect(forkPhase({ activationAt: '2026-08-13T00:00:00.000Z', activationPrecision: 'day' }, NOW)).toBe(FORK_PHASE.PAST);
    });

    it('prefers a precise time on the same day over a bare date', () => {
      const best = bestActivation([
        { at: '2026-09-16T00:00:00.000Z', evidence: 'stated', precision: 'day', rank: 0, observedAt: 2 },
        { at: '2026-09-16T17:00:00.000Z', evidence: 'stated', precision: 'time', rank: 1, observedAt: 1 }
      ]);
      expect(best.at).toBe('2026-09-16T17:00:00.000Z');
    });
  });

  it('reads enrichment.forks when present, without double-counting the primary', () => {
    const a = { name: 'Alpha', network: 'X', activationAt: null, activationBlock: null, state: null };
    const b = { ...a, name: 'Beta' };
    expect(forksOf({ fork: a, forks: [a, b] }).map(f => f.name)).toEqual(['Alpha', 'Beta']);
    expect(forksOf({ fork: null, forks: [a, b] })).toHaveLength(2);
    expect(forksOf({ fork: a })).toHaveLength(1);
    expect(forksOf({ fork: null })).toEqual([]);
  });
});
