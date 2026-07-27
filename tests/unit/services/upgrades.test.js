import { describe, it, expect } from 'vitest';
import { buildUpgradeEvents } from '../../../src/services/upgrades.js';
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
