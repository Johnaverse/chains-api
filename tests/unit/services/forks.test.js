import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForks } from '../../../src/services/forks.js';
import { getLiveEvents, getLiveEventsFetchedAt } from '../../../src/sources/liveIncidents.js';
import { getExplorerTip } from '../../../src/sources/blockscout.js';

vi.mock('../../../src/sources/liveIncidents.js', () => ({ getLiveEvents: vi.fn(), getLiveEventsFetchedAt: vi.fn() }));
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
    getExplorerTip.mockResolvedValue(null);
    getLiveEventsFetchedAt.mockReturnValue('2026-08-15T00:00:00.000Z');
  });

  it('groups a fork across sources and reports where it came from', async () => {
    getLiveEvents.mockResolvedValue([
      event('a', { fork: fork({ name: 'Protocol 28', activationAt: '2099-09-16T17:00:00Z' }), affectedChains: ['Stellar Mainnet'], page: 'xlm' }),
      event('b', { fork: fork({ name: 'Protocol 28' }), affectedChains: ['Stellar Mainnet'], page: 'quicknode' })
    ]);

    const out = await getForks();

    expect(out.count).toBe(1);
    expect(out.forks[0]).toMatchObject({ name: 'Protocol 28', network: 'stellar mainnet', phase: 'upcoming' });
    expect(out.forks[0].sources.sort()).toEqual(['quicknode', 'xlm']);
  });

  it('does not call the explorer when every activation is already stated', async () => {
    // The common case must cost no network round trip.
    getLiveEvents.mockResolvedValue([
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['MegaETH Mainnet'] })
    ]);

    await getForks();

    expect(getExplorerTip).not.toHaveBeenCalled();
  });

  it('converts a height-only fork through the explorer', async () => {
    // The Aleo shape: marked as a fork, never named, pinned only to a height.
    getLiveEvents.mockResolvedValue([
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
    getLiveEvents.mockResolvedValue([
      event('a', { fork: fork({ activationBlock: 18813000 }), chains: [1] })
    ]);
    getExplorerTip.mockRejectedValue(new Error('blockscout down'));

    const out = await getForks();

    expect(out.forks[0].activationAt).toBeNull();
    expect(out.forks[0].phase).toBe('unscheduled');
    expect(out.forks[0].activationBlock).toBe(18813000);   // the fact still survives
  });

  it('scheduledOnly drops forks with no known date — what a calendar needs', async () => {
    getLiveEvents.mockResolvedValue([
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
    getLiveEvents.mockResolvedValue([
      event('1', { fork: fork({ name: 'a', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['x'] }),
      event('2', { fork: fork({ name: 'b', activationAt: '2099-09-02T00:00:00Z' }), affectedChains: ['y'] }),
      event('3', { fork: fork({ name: 'c', activationAt: '2020-01-01T00:00:00Z' }), affectedChains: ['z'] })
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
    getLiveEvents.mockResolvedValue([
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
    getLiveEvents.mockResolvedValue([
      event('1', { fork: fork({ name: 'a', activationAt: '2099-09-01T00:00:00Z' }), chains: [1] }),
      event('2', { fork: fork({ name: 'b', activationAt: '2020-01-01T00:00:00Z' }), chains: [8453] })
    ]);

    expect((await getForks({ chainId: 1 })).count).toBe(1);
    expect((await getForks({ phase: 'past' })).forks[0].name).toBe('b');
  });

  it('compacts member events instead of embedding them whole', async () => {
    // Measured before this: 2210 bytes per fork, so a 50-fork page pretty-printed to ~250 KB
    // and the assistant — which truncates tool results at 8000 chars — would have seen two
    // forks under a header reading count: 50, truncated: false.
    getLiveEvents.mockResolvedValue([
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2099-09-01T00:00:00Z' }), affectedChains: ['MegaETH Mainnet'] })
    ]);

    const out = await getForks();
    const [member] = out.forks[0].events;

    expect(Object.keys(member).sort()).toEqual(['provider', 'publishedAt', 'status', 'title', 'url']);
    // publishedMs is an internal sort key; get_live_incidents already strips it for this reason.
    expect(member.publishedMs).toBeUndefined();
    expect(member.enrichment).toBeUndefined();
  });

  it('does not present an internal scope key as a network name', async () => {
    // `chain:8453` and `unscoped` are grouping keys. The tool description tells the model each
    // fork "carries network", so emitting those put an internal identifier in an answer.
    getLiveEvents.mockResolvedValue([
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2099-09-01T00:00:00Z' }), chains: [8453] }),
      event('b', { fork: fork({ name: 'Other', activationAt: '2099-09-02T00:00:00Z' }) })
    ]);

    const out = await getForks();

    expect(out.forks.map(f => f.network)).toEqual([null, null]);
  });

  it('reports the feed fetch time, not its own', async () => {
    // loadIncidents serves the last good cache through an upstream outage, so stamping "now"
    // would present hours-old forks as freshly fetched.
    getLiveEventsFetchedAt.mockReturnValue('2026-08-14T06:00:00.000Z');
    getLiveEvents.mockResolvedValue([]);

    expect((await getForks()).fetchedAt).toBe('2026-08-14T06:00:00.000Z');
  });

  it('attributes a fork to chains the model resolved, not only declared ones', async () => {
    // An OP Stack window names nine networks and declares none of them; filtering on declared
    // chains alone answered "no forks" for a chain that is genuinely affected.
    getLiveEvents.mockResolvedValue([{
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
    getLiveEvents.mockResolvedValue([event('a'), event('b')]);

    const out = await getForks();

    expect(out).toMatchObject({ count: 0, totalMatched: 0, truncated: false });
    expect(out.byPhase).toMatchObject({ upcoming: 0, past: 0, cancelled: 0, unscheduled: 0 });
  });
});
