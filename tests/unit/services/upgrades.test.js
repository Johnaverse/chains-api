import { describe, it, expect } from 'vitest';
import { buildUpgradeEvents, groupEventsByIncident } from '../../../src/services/upgrades.js';
import { networkSlug, networkSlugs } from '../../../src/domain/networkSlug.js';

// Events in the shape getLiveEvents() returns (normalized feed updates).
function ev(overrides = {}) {
  const publishedAt = overrides.publishedAt ?? '2026-07-27T13:00:00.000Z';
  return {
    title: 'Gnosis Chain - Mainnet - upgrade nethermind to v1.39.2',
    url: 'https://status.example/1',
    publishedAt,
    publishedMs: Date.parse(publishedAt),
    status: 'maintenance_scheduled',
    ongoing: false,
    impact: null,
    incidentId: 'quicknode:aaa',
    software: [{ client: 'nethermind', version: '1.39.2' }],
    urgency: 'standard',
    networkNames: ['Gnosis Chain'],
    networkSlugs: ['gnosis'],
    statusPage: { id: 'quicknode', name: 'QuickNode', kind: 'rpc-provider' },
    isProvider: true,
    chains: [{ chainId: 100, name: 'Gnosis' }],
    affectedComponents: [],
    ...overrides
  };
}

describe('networkSlug (contract copy)', () => {
  // These MUST match chains-status-news's implementation exactly — the rule is the contract.
  it.each([
    ['Solana Mainnet', 'solana'],
    ['Gnosis Chain', 'gnosis'],
    ['BNB Smart Chain', 'bnb-smart'],
    ['XRP Ledger', 'xrp'],
    ['Sui Testnet', 'sui-testnet'],
    ['Arbitrum Sepolia', 'arbitrum-sepolia']
  ])('canonicalizes %j -> %s', (name, slug) => {
    expect(networkSlug(name)).toBe(slug);
  });

  it('never aliases a testnet to its mainnet', () => {
    expect(networkSlug('Sui Testnet')).not.toBe(networkSlug('Sui Mainnet'));
  });

  it('dedupes equivalent names', () => {
    expect(networkSlugs(['Solana Mainnet', 'Solana'])).toEqual(['solana']);
  });
});

describe('buildUpgradeEvents', () => {
  it('builds one UpgradeEvent per incidentId, using the scheduled update for activation', () => {
    const events = [
      ev({ publishedAt: '2026-07-27T13:00:00.000Z', status: 'maintenance_scheduled' }),
      // A later "completed" update must not move the activation time.
      ev({ publishedAt: '2026-07-27T16:00:00.000Z', publishedMs: Date.parse('2026-07-27T16:00:00.000Z'), status: 'maintenance_completed' })
    ];
    const [upgrade] = buildUpgradeEvents(events);
    expect(buildUpgradeEvents(events)).toHaveLength(1);
    expect(upgrade.activationAt).toBe('2026-07-27T13:00:00.000Z');
    expect(upgrade.status).toBe('maintenance_completed'); // latest state
    expect(upgrade.updates).toBe(2);
    expect(upgrade.software).toEqual([{ client: 'nethermind', version: '1.39.2' }]);
  });

  it('links an incident within 24h on the same chainId as suspected fallout', () => {
    const events = [
      ev(),
      ev({
        incidentId: 'quicknode:bbb',
        title: 'RPC Degraded Performance on Gnosis',
        status: 'investigating',
        publishedAt: '2026-07-27T19:00:00.000Z',
        publishedMs: Date.parse('2026-07-27T19:00:00.000Z'),
        software: [], networkNames: [], networkSlugs: []
      })
    ];
    const [upgrade] = buildUpgradeEvents(events);
    expect(upgrade.followedByIncidents).toHaveLength(1);
    expect(upgrade.followedByIncidents[0]).toMatchObject({
      title: 'RPC Degraded Performance on Gnosis',
      hoursAfterActivation: 6,
      // Temporal correlation, never asserted causation.
      suspectedCause: 'upgrade'
    });
  });

  it('links by network slug when neither side has a chainId — the Solana/Canton case', () => {
    const events = [
      ev({ incidentId: 'q:up', title: 'Solana - Mainnet - Upgrade to v2.0', chains: [], networkNames: ['Solana Mainnet'], networkSlugs: ['solana'] }),
      ev({
        incidentId: 'q:inc', title: 'Major outage on Solana Mainnet nodes', status: 'major_outage',
        publishedAt: '2026-07-27T20:00:00.000Z', publishedMs: Date.parse('2026-07-27T20:00:00.000Z'),
        chains: [], software: [], networkNames: ['Solana Mainnet'], networkSlugs: ['solana']
      })
    ];
    const [upgrade] = buildUpgradeEvents(events);
    expect(upgrade.chainIds).toEqual([]);
    expect(upgrade.followedByIncidents).toHaveLength(1);
  });

  it('does NOT link incidents on a different network or outside the window', () => {
    const events = [
      ev(),
      ev({ incidentId: 'q:other', title: 'Base degraded', status: 'investigating', publishedAt: '2026-07-27T15:00:00.000Z', publishedMs: Date.parse('2026-07-27T15:00:00.000Z'), chains: [{ chainId: 8453, name: 'Base' }], networkNames: [], networkSlugs: [], software: [] }),
      ev({ incidentId: 'q:late', title: 'Gnosis degraded much later', status: 'investigating', publishedAt: '2026-07-30T13:00:00.000Z', publishedMs: Date.parse('2026-07-30T13:00:00.000Z'), networkNames: [], networkSlugs: [], software: [] }),
      ev({ incidentId: 'q:before', title: 'Gnosis degraded before', status: 'investigating', publishedAt: '2026-07-27T10:00:00.000Z', publishedMs: Date.parse('2026-07-27T10:00:00.000Z'), networkNames: [], networkSlugs: [], software: [] })
    ];
    const [upgrade] = buildUpgradeEvents(events);
    // Before activation, after the window, and other-network incidents all excluded.
    expect(upgrade.followedByIncidents).toEqual([]);
  });

  it('degrades to statusPage+title grouping when incidentId is absent (pre-upgrade feeds)', () => {
    const events = [
      ev({ incidentId: null }),
      ev({ incidentId: null, status: 'maintenance_in_progress', publishedAt: '2026-07-27T14:00:00.000Z', publishedMs: Date.parse('2026-07-27T14:00:00.000Z') })
    ];
    const upgrades = buildUpgradeEvents(events);
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].updates).toBe(2);
  });

  it('attaches forum discussion and news coverage by chainId within the context window', () => {
    const context = {
      forumPosts: [
        { title: 'Nethermind 1.39.2 upgrade discussion', url: 'https://f/1', publishedAt: '2026-07-25T00:00:00.000Z', chains: [{ chainId: 100, name: 'Gnosis' }] },
        { title: 'Unrelated other-chain thread', url: 'https://f/2', publishedAt: '2026-07-25T00:00:00.000Z', chains: [{ chainId: 1, name: 'Ethereum Mainnet' }] }
      ],
      newsItems: [
        // No chain mapping, but names the version — the secondary key must catch it.
        { title: 'Gnosis validators told to run v1.39.2', url: 'https://n/1', publishedAt: '2026-07-26T00:00:00.000Z', chains: [] },
        { title: 'Old article far outside the window', url: 'https://n/2', publishedAt: '2026-05-01T00:00:00.000Z', chains: [{ chainId: 100, name: 'Gnosis' }] }
      ]
    };
    const [upgrade] = buildUpgradeEvents([ev()], context);
    expect(upgrade.discussion.map((d) => d.url)).toEqual(['https://f/1']);
    expect(upgrade.coverage.map((c) => c.url)).toEqual(['https://n/1']);
  });

  it('returns [] for an empty or incident-only stream', () => {
    expect(buildUpgradeEvents([])).toEqual([]);
    expect(buildUpgradeEvents([ev({ status: 'investigating' })])).toEqual([]);
  });
});

describe('activation time — announcement vs window', () => {
  const NOW = Date.parse('2026-07-28T01:00:00.000Z');
  const at = (iso, overrides = {}) => ev({ publishedAt: iso, publishedMs: Date.parse(iso), ...overrides });

  it('uses the pending WINDOW, not the announcement that preceded it', () => {
    // Providers post twice: an announcement, then an entry whose own publishedAt
    // IS the window start. Taking the first scheduled update reported the
    // announcement as the activation, so every pending window rendered as past —
    // live, the dashboard read "Upcoming — 0 scheduled" with eleven pending.
    const events = [
      at('2026-07-22T13:50:00.000Z'),
      at('2026-08-03T14:00:00.000Z', { isWindowEntry: true })
    ];
    const [u] = buildUpgradeEvents(events, { now: NOW });
    expect(u.activationAt).toBe('2026-08-03T14:00:00.000Z');
    expect(u.announcedAt).toBe('2026-07-22T13:50:00.000Z');
  });

  it('identifies a window entry by its banner even when the status says completed', () => {
    // Hedera labels its window entries maintenance_completed up front; status
    // alone would miss them and fall back to the announcement.
    const events = [
      at('2026-07-27T19:26:00.000Z', { status: 'maintenance_completed' }),
      at('2026-07-28T17:00:00.000Z', { status: 'maintenance_completed', isWindowEntry: true })
    ];
    const [u] = buildUpgradeEvents(events, { now: NOW });
    expect(u.activationAt).toBe('2026-07-28T17:00:00.000Z');
  });

  it('falls back to the most recent past window once every occurrence has run', () => {
    const events = [
      at('2026-07-27T14:36:00.000Z'),
      at('2026-07-27T15:00:00.000Z', { isWindowEntry: true }),
      at('2026-07-27T19:00:00.000Z', { status: 'maintenance_completed' })
    ];
    const [u] = buildUpgradeEvents(events, { now: NOW });
    expect(u.activationAt).toBe('2026-07-27T15:00:00.000Z');
  });

  it('carries the window duration when the banner gave an end', () => {
    const events = [at('2026-08-03T14:00:00.000Z', {
      isWindowEntry: true, windowEndMs: Date.parse('2026-08-03T18:00:00.000Z')
    })];
    const [u] = buildUpgradeEvents(events, { now: NOW });
    expect(u.windowEndAt).toBe('2026-08-03T18:00:00.000Z');
    expect(u.windowMinutes).toBe(240);
  });

  it('orders pending windows soonest-first ahead of history newest-first', () => {
    const events = [
      at('2026-07-20T10:00:00.000Z', { incidentId: 'a', title: 'Upgrade A' }),
      at('2026-07-26T10:00:00.000Z', { incidentId: 'b', title: 'Upgrade B' }),
      at('2026-08-03T10:00:00.000Z', { incidentId: 'c', title: 'Upgrade C', isWindowEntry: true }),
      at('2026-07-29T10:00:00.000Z', { incidentId: 'd', title: 'Upgrade D', isWindowEntry: true })
    ];
    expect(buildUpgradeEvents(events, { now: NOW }).map((u) => u.incidentId)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('grouping across retitles', () => {
  it('merges updates whose titles differ only by a severity decoration', () => {
    // Live: QuickNode posted both forms for one Injective window, and the
    // dashboard drew two cards for a single upgrade.
    const events = [
      ev({ incidentId: null, title: '[Urgent] Injective Mainnet Upgrade to v1.20.3' }),
      ev({
        incidentId: null, title: 'Injective Mainnet Upgrade to v1.20.3',
        publishedAt: '2026-07-27T14:00:00.000Z', publishedMs: Date.parse('2026-07-27T14:00:00.000Z')
      }),
      ev({
        incidentId: null, title: '*URGENT* Injective Mainnet Upgrade to v1.20.3',
        status: 'maintenance_completed',
        publishedAt: '2026-07-27T15:00:00.000Z', publishedMs: Date.parse('2026-07-27T15:00:00.000Z')
      })
    ];
    const upgrades = buildUpgradeEvents(events);
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].updates).toBe(3);
  });

  it('still separates genuinely different windows on the same provider', () => {
    const events = [
      ev({ incidentId: null, title: '[Urgent] Gravity - Mainnet - Upgrade to v1.8.0' }),
      ev({ incidentId: null, title: '[Urgent] Gravity - Mainnet - Upgrade to v1.8.1' })
    ];
    expect(buildUpgradeEvents(events)).toHaveLength(2);
  });

  it('folds an announcement and its window entry into one rollout', () => {
    // Atlassian emits scheduled maintenance as TWO objects with different
    // GUIDs: the announcement and the window. Keying on incidentId alone split
    // 41 of 111 live windows into duplicate pairs.
    const events = [
      ev({ incidentId: 'q:announce', publishedAt: '2026-07-20T15:50:00.000Z', publishedMs: Date.parse('2026-07-20T15:50:00.000Z') }),
      ev({
        incidentId: 'q:window', publishedAt: '2026-07-29T14:00:00.000Z',
        publishedMs: Date.parse('2026-07-29T14:00:00.000Z'), isWindowEntry: true
      })
    ];
    const upgrades = buildUpgradeEvents(events, { now: Date.parse('2026-07-21T00:00:00.000Z') });
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].updates).toBe(2);
    expect(upgrades[0].activationAt).toBe('2026-07-29T14:00:00.000Z');
  });

  it('keeps same-titled INCIDENTS apart — recurring outages are not one event', () => {
    // "Superposition Testnet RPC went down" recurs verbatim across separate
    // outages; folding those would undercount incidents and understate downtime.
    const events = [
      ev({ incidentId: 'q:1', title: 'RPC went down', status: 'investigating' }),
      ev({
        incidentId: 'q:2', title: 'RPC went down', status: 'investigating',
        publishedAt: '2026-07-28T13:00:00.000Z', publishedMs: Date.parse('2026-07-28T13:00:00.000Z')
      })
    ];
    expect(groupEventsByIncident(events)).toHaveLength(2);
  });
});
