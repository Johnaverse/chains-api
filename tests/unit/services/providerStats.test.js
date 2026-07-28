import { describe, it, expect } from 'vitest';
import { buildProviderStats, PROVIDER_DOMAINS } from '../../../src/services/providerStats.js';

// Frozen clock: every fixture timestamp is relative to this instant.
const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const HOUR = 3600000;
const DAY = 24 * HOUR;

// Events in the shape getLiveEvents() returns (normalized feed updates).
function ev(overrides = {}) {
  const publishedMs = overrides.publishedMs ?? NOW - 2 * HOUR;
  return {
    title: 'Elevated error rates on Ethereum Mainnet',
    url: 'https://status.example/1',
    publishedAt: new Date(publishedMs).toISOString(),
    publishedMs,
    status: 'investigating',
    ongoing: false,
    impact: null,
    incidentId: 'quicknode:inc-1',
    software: [],
    urgency: null,
    networkNames: [],
    networkSlugs: [],
    statusPage: { id: 'quicknode', name: 'QuickNode', kind: 'rpc-provider' },
    isProvider: true,
    chains: [{ chainId: 1, name: 'Ethereum' }],
    affectedComponents: [],
    ...overrides
  };
}

// A chain-operator event that must never leak into provider stats.
function chainEv(overrides = {}) {
  return ev({
    incidentId: 'base:inc-9',
    statusPage: { id: 'base', name: 'Base', kind: 'chain' },
    isProvider: false,
    ...overrides
  });
}

// Keep the window anchored at exactly 30d regardless of other fixtures.
function anchor() {
  return chainEv({ incidentId: 'anchor', publishedMs: NOW - 40 * DAY, status: 'resolved' });
}

describe('buildProviderStats — incident grouping and window', () => {
  it('groups updates by incidentId into ONE incident (same rule as upgrades.js)', () => {
    const events = [
      anchor(),
      ev({ publishedMs: NOW - 5 * HOUR, status: 'investigating' }),
      ev({ publishedMs: NOW - 4 * HOUR, status: 'identified' }),
      ev({ publishedMs: NOW - 2 * HOUR, status: 'resolved' })
    ];
    const { providers } = buildProviderStats(events, { now: NOW });
    const q = providers.find((p) => p.id === 'quicknode');
    expect(q.incidents30d).toBe(1);
  });

  it('falls back to statusPage|title grouping when incidentId is absent', () => {
    const events = [
      anchor(),
      ev({ incidentId: null, publishedMs: NOW - 5 * HOUR }),
      ev({ incidentId: null, publishedMs: NOW - 3 * HOUR, status: 'resolved' }),
      ev({ incidentId: null, title: 'A different outage', publishedMs: NOW - 2 * HOUR })
    ];
    const { providers } = buildProviderStats(events, { now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').incidents30d).toBe(2);
  });

  it('caps windowDays at 30 and shrinks it to feed retention when younger', () => {
    const capped = buildProviderStats([anchor()], { now: NOW });
    expect(capped.windowDays).toBe(30);

    const young = buildProviderStats([ev({ publishedMs: NOW - 3 * DAY })], { now: NOW });
    expect(young.windowDays).toBe(3);
  });

  it('excludes incidents whose FIRST update predates the window', () => {
    const events = [
      anchor(),
      // First update 31d ago, latest inside the window: still out.
      ev({ incidentId: 'q:old', publishedMs: NOW - 31 * DAY, status: 'investigating' }),
      ev({ incidentId: 'q:old', publishedMs: NOW - 1 * DAY, status: 'resolved' })
    ];
    const { providers } = buildProviderStats(events, { now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').incidents30d).toBe(0);
  });

  it('ignores chain-operator events entirely', () => {
    const { providers } = buildProviderStats([anchor(), chainEv()], { now: NOW });
    expect(providers.find((p) => p.id === 'base')).toBeUndefined();
  });
});

describe('buildProviderStats — per-provider metrics', () => {
  it('separates incidents from maintenance and counts ongoing', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:1', publishedMs: NOW - 5 * DAY, status: 'investigating', ongoing: true }),
      // Distinct titles: same-titled maintenance entries are one rollout
      // (a provider's announcement and its window carry different GUIDs).
      ev({ incidentId: 'q:2', title: 'Upgrade to v2', publishedMs: NOW - 3 * DAY, status: 'maintenance_scheduled' }),
      ev({ incidentId: 'q:3', title: 'Upgrade to v3', publishedMs: NOW - 1 * DAY, status: 'maintenance_completed' })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.incidents30d).toBe(1);
    expect(q.maintenance30d).toBe(2);
    expect(q.ongoingNow).toBe(1);
  });

  it('counts maintenance in progress separately from open incidents', () => {
    // The feed sets ongoing:true on both. Counting them together put an
    // alarm-red "4 ongoing" on QuickNode when all four were planned upgrades
    // running to schedule — 10 of 12 live ongoing events were maintenance.
    const events = [
      anchor(),
      ev({ incidentId: 'q:inc', title: 'RPC outage', publishedMs: NOW - 3 * HOUR, status: 'investigating', ongoing: true }),
      ev({ incidentId: 'q:m1', title: 'Upgrade Lighthouse', publishedMs: NOW - 2 * HOUR, status: 'maintenance_in_progress', ongoing: true }),
      ev({ incidentId: 'q:m2', title: 'Upgrade Erigon', publishedMs: NOW - 1 * HOUR, status: 'maintenance_in_progress', ongoing: true })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.ongoingNow).toBe(1);
    expect(q.ongoingMaintenance).toBe(2);
    // "Longest open" must track the incident, not the older maintenance window.
    expect(q.oldestOngoingAt).toBe(new Date(NOW - 3 * HOUR).toISOString());
  });

  it('never loses an ongoing event whose status is in neither set', () => {
    // The two status sets do not cover what the feed emits: `status` is passed through
    // unvalidated and `unknown` is 178 of 438 live events. Partitioning on both sets alone
    // let such an event vanish from ongoingNow AND ongoingMaintenance, so the caption read
    // "no open incidents" while it was burning.
    const events = [
      anchor(),
      ev({ incidentId: 'q:weird', title: 'Something is wrong', publishedMs: NOW - 4 * HOUR, status: 'unknown', ongoing: true }),
      ev({ incidentId: 'q:null', title: 'Unlabelled', publishedMs: NOW - 2 * HOUR, status: null, ongoing: true })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.ongoingNow).toBe(2);
    expect(q.ongoingMaintenance).toBe(0);
    // And it still anchors "longest open", so the duration is not silently lost either.
    expect(q.oldestOngoingAt).toBe(new Date(NOW - 4 * HOUR).toISOString());
  });

  it('still counts an incident as ongoing when it started before the window', () => {
    const events = [
      ev({ incidentId: 'q:stuck', publishedMs: NOW - 40 * DAY, status: 'investigating', ongoing: true })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.incidents30d).toBe(0); // out of window…
    expect(q.ongoingNow).toBe(1);   // …but burning NOW
  });

  it('computes median and avg resolution hours from first update to FIRST resolved update', () => {
    const events = [
      anchor(),
      // Incident A: resolved after 2h.
      ev({ incidentId: 'q:a', publishedMs: NOW - 10 * DAY, status: 'investigating' }),
      ev({ incidentId: 'q:a', publishedMs: NOW - 10 * DAY + 2 * HOUR, status: 'resolved' }),
      // Incident B: resolved after 6h (a second resolved update later must not count).
      ev({ incidentId: 'q:b', publishedMs: NOW - 5 * DAY, status: 'investigating' }),
      ev({ incidentId: 'q:b', publishedMs: NOW - 5 * DAY + 6 * HOUR, status: 'resolved' }),
      ev({ incidentId: 'q:b', publishedMs: NOW - 5 * DAY + 9 * HOUR, status: 'resolved' }),
      // Incident C: never resolved — excluded from resolution stats.
      ev({ incidentId: 'q:c', publishedMs: NOW - 1 * DAY, status: 'investigating' })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.resolutionHours).toEqual({ median: 4, avg: 4, samples: 2 });
    // Two of the three incidents showed both ends; the UI needs that ratio to
    // decide whether the median is a rate or an anecdote.
    expect(q.disclosure.resolutionTracked).toBeCloseTo(0.67, 2);
  });

  it('does not treat a resolved-only incident as resolved in 0h', () => {
    // Most providers publish a history RSS carrying ONLY the final "resolved"
    // entry. Measuring first->resolved across those yields 0h and rendered as a
    // confident "~0h resolves in (median)" on nine of ten live provider cards.
    const events = [
      anchor(),
      ev({ incidentId: 'q:only', publishedMs: NOW - 3 * DAY, status: 'resolved' }),
      ev({ incidentId: 'q:only2', publishedMs: NOW - 4 * DAY, status: 'resolved' })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.resolutionHours).toBeNull();
    expect(q.disclosure.resolutionTracked).toBe(0);
  });

  it('marks a provider comparable only with both a chain list and posted incidents', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:a', publishedMs: NOW - 2 * DAY, status: 'investigating' })
    ];
    const pages = [
      { id: 'quicknode', name: 'QuickNode', kind: 'rpc-provider', coverage: { chainsListed: 10 } },
      // Publishes a chain list but has posted nothing: a silent page scores a
      // meaningless 100%, so it must not rank against pages that do report.
      { id: 'silent', name: 'Silent', kind: 'rpc-provider', coverage: { chainsListed: 40 } }
    ];
    const { providers } = buildProviderStats(events, { statusPages: pages, now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').disclosure.comparable).toBe(true);
    expect(providers.find((p) => p.id === 'silent').disclosure).toMatchObject({
      comparable: false, postsIncidents: false, publishesChainCoverage: true
    });
  });

  it('spreads an incident\'s chain-hours across the days it burned, counting it once', () => {
    const events = [
      anchor(),
      // Two chains down for 48h, ending 24h ago.
      ev({
        incidentId: 'q:long', publishedMs: NOW - 3 * DAY, status: 'investigating',
        chains: [{ chainId: 1, name: 'Ethereum' }, { chainId: 10, name: 'Optimism' }]
      }),
      ev({
        incidentId: 'q:long', publishedMs: NOW - 1 * DAY, status: 'resolved',
        chains: [{ chainId: 1, name: 'Ethereum' }, { chainId: 10, name: 'Optimism' }]
      })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    const days = q.dailySeries;
    expect(days).toHaveLength(30);
    // Counted as ONE incident on the day it opened, not once per day it ran.
    expect(days.reduce((n, d) => n + d.incidents, 0)).toBe(1);
    // 48h x 2 chains = 96 chain-hours, spread over the days it actually burned.
    expect(days.reduce((n, d) => n + d.chainHoursLost, 0)).toBeCloseTo(96, 1);
    expect(days.filter((d) => d.chainHoursLost > 0).length).toBeGreaterThan(1);
  });

  it('reports resolutionHours null when no incident resolved', () => {
    const events = [anchor(), ev({ status: 'investigating' })];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.resolutionHours).toBeNull();
  });

  it('counts distinct chains affected across incident groups', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:1', publishedMs: NOW - 5 * DAY, chains: [{ chainId: 1, name: 'Ethereum' }, { chainId: 137, name: 'Polygon' }] }),
      ev({ incidentId: 'q:2', publishedMs: NOW - 2 * DAY, chains: [{ chainId: 137, name: 'Polygon' }] })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.chainsAffected30d).toBe(2);
  });

  it('sorts providers by incidents30d descending', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:1', publishedMs: NOW - 2 * DAY }),
      ev({ incidentId: 'i:1', publishedMs: NOW - 3 * DAY, statusPage: { id: 'infura', name: 'Infura', kind: 'rpc-provider' } }),
      ev({ incidentId: 'i:2', publishedMs: NOW - 1 * DAY, statusPage: { id: 'infura', name: 'Infura', kind: 'rpc-provider' } })
    ];
    const { providers } = buildProviderStats(events, { now: NOW });
    expect(providers.map((p) => p.id)).toEqual(['infura', 'quicknode']);
  });
});

describe('buildProviderStats — chain-weighted availability', () => {
  const qnPage = (chainsListed) => [{
    id: 'quicknode',
    name: 'QuickNode',
    kind: 'rpc-provider',
    coverage: { chainsListed, chainIdsResolved: [], componentCount: 0 }
  }];

  it('worked example: provider supports 10 chains, one incident takes 1 chain down for the full 24h window → last24h availability = 90%', () => {
    const events = [
      anchor(),
      // Started before the window, still unresolved: covers all 24h of it.
      ev({ incidentId: 'q:down', publishedMs: NOW - 30 * HOUR, status: 'investigating', ongoing: true, chains: [{ chainId: 1, name: 'Ethereum' }] })
    ];
    const q = buildProviderStats(events, { statusPages: qnPage(10), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h).toEqual({ percent: 90, chainHoursLost: 24 });
    expect(q.availability.basis).toBe('status-page-chains');
    expect(q.availability.selfReported).toBe(true);
    expect(q.availability.chainsSupported).toBe(10);
    // The 7d window only loses the incident's actual 30h: 1 - 30/(10*168).
    expect(q.availability.last7d.chainHoursLost).toBe(30);
    expect(q.availability.last7d.percent).toBe(98.21);
  });

  it('merges overlapping incidents on the same chain — simultaneous incidents are not double downtime', () => {
    const events = [
      anchor(),
      // Two incidents on chain 1: 10h→4h ago and 8h→2h ago. Merged: 10h→2h = 8h,
      // not 6h + 6h = 12h.
      ev({ incidentId: 'q:one', publishedMs: NOW - 10 * HOUR, status: 'investigating' }),
      ev({ incidentId: 'q:one', publishedMs: NOW - 4 * HOUR, status: 'resolved' }),
      ev({ incidentId: 'q:two', publishedMs: NOW - 8 * HOUR, status: 'investigating' }),
      ev({ incidentId: 'q:two', publishedMs: NOW - 2 * HOUR, status: 'resolved' })
    ];
    const q = buildProviderStats(events, { statusPages: qnPage(10), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h.chainHoursLost).toBe(8);
    expect(q.availability.last24h.percent).toBe(Math.round((1 - 8 / 240) * 10000) / 100);
  });

  it('clips an ongoing incident to each window boundary', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:long', publishedMs: NOW - 3 * DAY, status: 'investigating', ongoing: true })
    ];
    const q = buildProviderStats(events, { statusPages: qnPage(10), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h.chainHoursLost).toBe(24); // clipped to the window
    expect(q.availability.last7d.chainHoursLost).toBe(72);  // its real 3d
    expect(q.availability.last30d.chainHoursLost).toBe(72);
  });

  it('an incident mapping to no chain counts as exactly 1 chain-equivalent', () => {
    const events = [
      anchor(),
      // Provider-wide/dashboard incident: no chain attribution possible.
      ev({ incidentId: 'q:wide', publishedMs: NOW - 6 * HOUR, status: 'investigating', ongoing: true, chains: [] })
    ];
    const q = buildProviderStats(events, { statusPages: qnPage(10), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h).toEqual({ percent: 97.5, chainHoursLost: 6 }); // 1 - 6/240
  });

  it('clamps an incident claiming more chains than the page lists — percent never goes below 0', () => {
    const events = [
      anchor(),
      ev({
        incidentId: 'q:big',
        publishedMs: NOW - 30 * HOUR,
        status: 'investigating',
        ongoing: true,
        chains: [{ chainId: 1 }, { chainId: 137 }, { chainId: 10 }]
      })
    ];
    // Page lists only 2 chains; the incident claims 3. Charge at most 2.
    const q = buildProviderStats(events, { statusPages: qnPage(2), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h.chainHoursLost).toBe(48); // 2 chains × 24h, full window
    expect(q.availability.last24h.percent).toBe(0);
  });

  it('coverage unavailable → null percents with a note (never a registry fallback)', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:down', publishedMs: NOW - 6 * HOUR, status: 'investigating', ongoing: true })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.chainsSupported).toBeNull();
    expect(q.availability.last24h.percent).toBeNull();
    expect(q.availability.last7d.percent).toBeNull();
    expect(q.availability.last30d.percent).toBeNull();
    expect(q.availability.note).toContain('chain coverage unavailable');
    // The numerator is still well-defined and reported.
    expect(q.availability.last24h.chainHoursLost).toBe(6);
  });

  it('notes a partial window when feed retention is younger than 30d, and exposes oldestEventAt', () => {
    // No anchor: the oldest event is only 3d old.
    const events = [ev({ publishedMs: NOW - 3 * DAY, status: 'resolved' })];
    const result = buildProviderStats(events, { statusPages: qnPage(10), now: NOW });
    expect(result.oldestEventAt).toBe(new Date(NOW - 3 * DAY).toISOString());
    const q = result.providers.find((p) => p.id === 'quicknode');
    expect(q.availability.note).toContain('partial window');
  });

  it('excludes an incident whose duration the page never published', () => {
    // The dominant live shape: 143 of 149 incidents appear exactly once, at
    // resolution. Charging them "until now" turned a July 7 outage into three
    // weeks of current downtime and put Infura at 96% for a quiet day.
    const events = [
      anchor(),
      ev({ incidentId: 'q:old', publishedMs: NOW - 20 * DAY, status: 'resolved', ongoing: false }),
      ev({ incidentId: 'q:old2', publishedMs: NOW - 2 * DAY, status: 'resolved', ongoing: false })
    ];
    const q = buildProviderStats(events, { statusPages: qnPage(10), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h.chainHoursLost).toBe(0);
    expect(q.availability.last30d.chainHoursLost).toBe(0);
    expect(q.availability.last30d.percent).toBe(100);
    expect(q.availability.measuredIncidents).toBe(0);
    expect(q.availability.unknownDurationIncidents).toBe(2);
    expect(q.availability.note).toContain('2 incidents of unpublished duration excluded');
    // The incidents themselves are still counted and still shown.
    expect(q.incidents30d).toBe(2);
  });

  it('still charges an incident the feed marks ongoing, right up to now', () => {
    const events = [
      anchor(),
      ev({ incidentId: 'q:live', publishedMs: NOW - 6 * HOUR, status: 'investigating', ongoing: true })
    ];
    const q = buildProviderStats(events, { statusPages: qnPage(10), now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.availability.last24h.chainHoursLost).toBe(6);
    expect(q.availability.measuredIncidents).toBe(1);
  });

  it('a silent provider (coverage present, zero events) self-reports a perfect 100 in every window', () => {
    const statusPages = [{ id: 'getblock', name: 'GetBlock', kind: 'rpc-provider', coverage: { chainsListed: 5, chainIdsResolved: [], componentCount: 0 } }];
    const g = buildProviderStats([anchor()], { statusPages, now: NOW }).providers.find((p) => p.id === 'getblock');
    expect(g.incidents30d).toBe(0);
    // Silence looks perfect — hence the selfReported labelling.
    expect(g.availability.last24h).toEqual({ percent: 100, chainHoursLost: 0 });
    expect(g.availability.last7d.percent).toBe(100);
    expect(g.availability.last30d.percent).toBe(100);
    expect(g.availability.selfReported).toBe(true);
  });
});

describe('buildProviderStats — endpointReachability (registry data quality, not uptime)', () => {
  const events = [anchor(), ev()];

  it('matches endpoints by domain, including deep subdomains', () => {
    const statusPages = [{ id: 'alchemy', name: 'Alchemy', kind: 'rpc-provider' }];
    const rpcResults = [
      { url: 'https://eth-mainnet.g.alchemy.com/v2/demo', status: 'working', chainId: 1 },
      { url: 'https://polygon-mainnet.g.alchemy.com/v2/demo', status: 'failed', chainId: 137 },
      { url: 'https://eth-mainnet.alchemyapi.io/v2/demo', status: 'working', chainId: 1 },
      // Same-suffix trap: NOT alchemy.com, must not match.
      { url: 'https://notalchemy.com/rpc', status: 'working', chainId: 1 },
      { url: 'https://mainnet.infura.io/v3/demo', status: 'working', chainId: 1 }
    ];
    const { providers } = buildProviderStats(events, { statusPages, rpcResults, now: NOW });
    const a = providers.find((p) => p.id === 'alchemy');
    expect(a.endpointReachability).toEqual({ working: 2, total: 3, percent: 66.7, registryChains: 2 });
  });

  it('is null when no registry endpoint matches the provider', () => {
    const { providers } = buildProviderStats(events, { rpcResults: [], now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').endpointReachability).toBeNull();
  });

  it('covers both quicknode domains', () => {
    const rpcResults = [
      { url: 'https://xyz.matic.quiknode.pro/abc', status: 'working', chainId: 137 },
      { url: 'https://endpoints.quicknode.com/eth', status: 'working', chainId: 1 }
    ];
    const { providers } = buildProviderStats(events, { rpcResults, now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').endpointReachability.total).toBe(2);
  });

  it('domain map covers every provider the feed publishes', () => {
    for (const id of ['infura', 'quicknode', 'alchemy', 'chainstack', 'drpc', 'blockdaemon', 'blockpi', 'getblock', 'tenderly', 'pinax']) {
      expect(PROVIDER_DOMAINS[id]?.length).toBeGreaterThan(0);
    }
  });
});

describe('buildProviderStats — coverage (self-declared)', () => {
  it('exposes chainsSupported/chainsResolved when the catalog carries coverage', () => {
    const statusPages = [{
      id: 'quicknode',
      name: 'QuickNode',
      kind: 'rpc-provider',
      coverage: { chainsListed: 45, chainIdsResolved: [1, 137, 8453], componentCount: 60 }
    }];
    const { providers } = buildProviderStats([anchor(), ev()], { statusPages, now: NOW });
    const q = providers.find((p) => p.id === 'quicknode');
    expect(q.chainsSupported).toBe(45);
    expect(q.chainsResolved).toBe(3);
  });

  it('tolerates coverage absence (prod predates the field): both null', () => {
    const statusPages = [{ id: 'quicknode', name: 'QuickNode', kind: 'rpc-provider' }];
    const { providers } = buildProviderStats([anchor(), ev()], { statusPages, now: NOW });
    const q = providers.find((p) => p.id === 'quicknode');
    expect(q.chainsSupported).toBeNull();
    expect(q.chainsResolved).toBeNull();
  });

  it('prefers the catalog name and keeps working with no catalog at all', () => {
    const { providers } = buildProviderStats([anchor(), ev()], { now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').name).toBe('QuickNode');
  });
});
