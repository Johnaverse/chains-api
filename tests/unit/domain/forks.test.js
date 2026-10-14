import { describe, it, expect } from 'vitest';
import {
  forkKey, forkScopes, normalizeForkName, resolveForkActivation, forkPhase,
  bestActivation, bestState, buildForks, FORK_PHASE, forkIdentity, scopeName, sourceRank,
  registryScopes, scopeLookups
} from '../../../src/domain/forks.js';

const NOW = Date.parse('2026-08-14T12:00:00Z');

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
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2026-08-25T03:00:00Z' }), page: 'quicknode', updatedAt: '2026-08-10T00:00:00Z' }),
      event('b', { fork: fork({ name: 'Rex6', activationAt: '2026-08-28T03:00:00Z', state: 'rescheduled' }), page: 'megaeth', updatedAt: '2026-08-13T00:00:00Z' })
    ];
    const [forkOut] = await buildForks(events, { now: NOW });

    expect(forkOut.activationAt).toBe('2026-08-28T03:00:00.000Z');
    expect(forkOut.state).toBe('rescheduled');
    expect(forkOut.phase).toBe(FORK_PHASE.UPCOMING);
  });
});

describe('forks across status, forum and news feeds', () => {
  // A mention from chains-forum-news or chains-news, in the shape src/sources/forkFeeds.js builds.
  const mention = (id, feed, f, { affectedChains = [], weight = null, page = id, kind, publishedAt = '2026-09-28T00:00:00Z' } = {}) => ({
    id, feed, title: `t-${id}`, publishedAt, updatedAt: publishedAt, weight,
    statusPage: { id: page, kind: kind ?? feed }, chains: [],
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

  it('keeps a multi-network window on the test network the fork network names alongside', () => {
    // fork.network narrows the scopes; it must not drop "Stellar Testnet" from a window covering both.
    const window = mention('qn', 'status', { name: 'Protocol 28', network: 'Stellar Mainnet' }, { affectedChains: ['Stellar Mainnet', 'Stellar Testnet'] });
    expect(forkScopes(window)).toEqual(['stellar', 'stellar testnet']);
    // A longer name that is a different network is not a test network of it.
    const etc = mention('etc', 'forum', { name: 'Olympia', network: 'Ethereum Classic' }, { affectedChains: ['Ethereum Classic', 'Ethereum'] });
    expect(forkScopes(etc)).toEqual(['ethereum classic']);
  });

  it('follows a reschedule that newer provider windows report, even over the network page', async () => {
    const out = await buildForks([
      mention('page', 'status', { name: 'Protocol 30', network: 'X', activationAt: '2099-09-01T00:00:00Z' }, { kind: 'chain', publishedAt: '2026-08-01T00:00:00Z' }),
      mention('qn', 'status', { name: 'Protocol 30', network: 'X', activationAt: '2099-09-15T00:00:00Z' }, { kind: 'rpc-provider', publishedAt: '2026-08-20T00:00:00Z' }),
      mention('alc', 'status', { name: 'Protocol 30', network: 'X', activationAt: '2099-09-15T01:00:00Z' }, { kind: 'rpc-provider', publishedAt: '2026-08-21T00:00:00Z' })
    ], { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].activationAt).toBe('2099-09-15T01:00:00.000Z');
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
    expect(registryScopes('Base Sepolia Testnet')).toEqual(['base sepolia testnet', 'base sepolia']);
    expect(registryScopes('Ethereum Mainnet')).toEqual(['ethereum']);
  });
});
