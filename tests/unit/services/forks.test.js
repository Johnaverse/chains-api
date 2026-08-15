import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getForks } from '../../../src/services/forks.js';
import { getLiveEvents } from '../../../src/sources/liveIncidents.js';
import { getExplorerTip } from '../../../src/sources/blockscout.js';

vi.mock('../../../src/sources/liveIncidents.js', () => ({ getLiveEvents: vi.fn() }));
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
  });

  it('groups a fork across sources and reports where it came from', async () => {
    getLiveEvents.mockResolvedValue([
      event('a', { fork: fork({ name: 'Protocol 28', activationAt: '2026-09-16T17:00:00Z' }), affectedChains: ['Stellar Mainnet'], page: 'xlm' }),
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
      event('a', { fork: fork({ name: 'Rex6', activationAt: '2026-09-01T00:00:00Z' }), affectedChains: ['MegaETH Mainnet'] })
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
      event('dated', { fork: fork({ name: 'Dated', activationAt: '2026-09-01T00:00:00Z' }), affectedChains: ['A'] }),
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
      event('1', { fork: fork({ name: 'a', activationAt: '2026-09-01T00:00:00Z' }), affectedChains: ['x'] }),
      event('2', { fork: fork({ name: 'b', activationAt: '2026-09-02T00:00:00Z' }), affectedChains: ['y'] }),
      event('3', { fork: fork({ name: 'c', activationAt: '2020-01-01T00:00:00Z' }), affectedChains: ['z'] })
    ]);

    const out = await getForks({ limit: 1 });

    expect(out.count).toBe(1);
    expect(out.totalMatched).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.byPhase).toMatchObject({ upcoming: 2, past: 1 });
  });

  it('filters by chain and by phase', async () => {
    getLiveEvents.mockResolvedValue([
      event('1', { fork: fork({ name: 'a', activationAt: '2026-09-01T00:00:00Z' }), chains: [1] }),
      event('2', { fork: fork({ name: 'b', activationAt: '2020-01-01T00:00:00Z' }), chains: [8453] })
    ]);

    expect((await getForks({ chainId: 1 })).count).toBe(1);
    expect((await getForks({ phase: 'past' })).forks[0].name).toBe('b');
  });

  it('returns an empty result rather than throwing when nothing carries a fork', async () => {
    getLiveEvents.mockResolvedValue([event('a'), event('b')]);

    const out = await getForks();

    expect(out).toMatchObject({ count: 0, totalMatched: 0, truncated: false });
    expect(out.byPhase).toMatchObject({ upcoming: 0, past: 0, cancelled: 0, unscheduled: 0 });
  });
});
