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
      ev({ incidentId: 'q:2', publishedMs: NOW - 3 * DAY, status: 'maintenance_scheduled' }),
      ev({ incidentId: 'q:3', publishedMs: NOW - 1 * DAY, status: 'maintenance_completed' })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.incidents30d).toBe(1);
    expect(q.maintenance30d).toBe(2);
    expect(q.ongoingNow).toBe(1);
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
    expect(q.resolutionHours).toEqual({ median: 4, avg: 4 });
  });

  it('reports resolutionHours null when no incident resolved', () => {
    const events = [anchor(), ev({ status: 'investigating' })];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    expect(q.resolutionHours).toBeNull();
  });

  it('selfReportedAvailability = 1 - admitted downtime / window, unresolved running to now', () => {
    const windowMs = 30 * DAY;
    const events = [
      anchor(),
      // Resolved: 3h of admitted downtime.
      ev({ incidentId: 'q:r', publishedMs: NOW - 10 * DAY, status: 'investigating' }),
      ev({ incidentId: 'q:r', publishedMs: NOW - 10 * DAY + 3 * HOUR, status: 'resolved' }),
      // Unresolved: down from first report until NOW (12h).
      ev({ incidentId: 'q:u', publishedMs: NOW - 12 * HOUR, status: 'investigating' })
    ];
    const q = buildProviderStats(events, { now: NOW }).providers.find((p) => p.id === 'quicknode');
    const expected = Math.round((1 - (15 * HOUR) / windowMs) * 10000) / 10000;
    expect(q.selfReportedAvailability).toBe(expected);
  });

  it('a silent provider (catalog entry, zero events) self-reports a perfect 1.0', () => {
    const statusPages = [{ id: 'getblock', name: 'GetBlock', kind: 'rpc-provider' }];
    const { providers } = buildProviderStats([anchor()], { statusPages, now: NOW });
    const g = providers.find((p) => p.id === 'getblock');
    expect(g).toBeDefined();
    expect(g.incidents30d).toBe(0);
    expect(g.selfReportedAvailability).toBe(1); // silence looks perfect — hence the label
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

describe('buildProviderStats — endpointHealth (OUR probes)', () => {
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
    expect(a.endpointHealth).toEqual({ working: 2, total: 3, percent: 66.7, registryChains: 2 });
  });

  it('is null when no registry endpoint matches the provider', () => {
    const { providers } = buildProviderStats(events, { rpcResults: [], now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').endpointHealth).toBeNull();
  });

  it('covers both quicknode domains', () => {
    const rpcResults = [
      { url: 'https://xyz.matic.quiknode.pro/abc', status: 'working', chainId: 137 },
      { url: 'https://endpoints.quicknode.com/eth', status: 'working', chainId: 1 }
    ];
    const { providers } = buildProviderStats(events, { rpcResults, now: NOW });
    expect(providers.find((p) => p.id === 'quicknode').endpointHealth.total).toBe(2);
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
