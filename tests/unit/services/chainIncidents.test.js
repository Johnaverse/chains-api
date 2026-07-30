import { describe, expect, it } from 'vitest';
import { correlateChainIncidents, MIN_PROVIDERS } from '../../../src/services/chainIncidents.js';

// The live case this exists for: three providers, one chain, inside 43 minutes,
// previously presented as three unrelated provider cards.
const ROBINHOOD = [
  ['chainstack', 'Robinhood Testnet Global Outage', 'investigating', '2026-07-30T06:47:00Z'],
  ['quicknode', 'Robinhood Testnet : Degraded Performance', 'investigating', '2026-07-30T07:08:53Z'],
  ['infura', 'Robinhood Testnet JSON-RPC Degraded', 'monitoring', '2026-07-30T07:46:49Z']
];

const incident = ([provider, title, status, at], over = {}) => ({
  title,
  status,
  ongoing: true,
  isProvider: true,
  publishedAt: at,
  publishedMs: Date.parse(at),
  statusPage: { id: provider, name: provider, kind: 'rpc-provider' },
  chains: [],
  networkNames: [],
  ...over
});

// Resolver stub: every "Robinhood Testnet" title is chain 46630, read from the title.
const resolve = (it) => (/robinhood testnet/i.test(it.title)
  ? { chainId: 46630, name: 'Robinhood Chain Testnet', evidence: 'title', query: 'Robinhood Testnet' }
  : null);

const correlate = (incidents, opts = {}) => correlateChainIncidents(incidents, { resolve, ...opts });

describe('correlateChainIncidents', () => {
  it('promotes three providers on one chain into a single chain-level incident', () => {
    const events = correlate(ROBINHOOD.map((r) => incident(r)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      chainId: 46630,
      chainName: 'Robinhood Chain Testnet',
      kind: 'incident',
      providerCount: 3,
      providers: ['chainstack', 'infura', 'quicknode'],
      chainEvidence: ['title']
    });
    // Earliest report, and named "firstReported" rather than "started": nobody
    // published when the chain broke, only when each provider noticed.
    expect(events[0].firstReportedAt).toBe('2026-07-30T06:47:00.000Z');
    expect(events[0].latestReportAt).toBe('2026-07-30T07:46:49.000Z');
    expect(events[0].reports.map((r) => r.provider)).toEqual(['chainstack', 'quicknode', 'infura']);
  });

  it('leaves a single provider alone — that is a statement about the provider', () => {
    expect(correlate([incident(ROBINHOOD[0])])).toEqual([]);
    expect(MIN_PROVIDERS).toBe(2);
  });

  it('does not let one provider corroborate itself with several updates', () => {
    const twice = [incident(ROBINHOOD[0]), incident(ROBINHOOD[0], { publishedAt: '2026-07-30T08:00:00Z', publishedMs: Date.parse('2026-07-30T08:00:00Z') })];
    expect(correlate(twice)).toEqual([]);
  });

  it('never merges maintenance with an outage on the same chain', () => {
    const events = correlate([
      incident(ROBINHOOD[0]),
      incident(ROBINHOOD[1]),
      incident(['blockdaemon', 'Robinhood Testnet - Upgrade to v2', 'maintenance_in_progress', '2026-07-30T09:00:00Z']),
      incident(['pinax', 'Robinhood Testnet - Upgrade to v2', 'maintenance_in_progress', '2026-07-30T09:05:00Z'])
    ]);
    // Two events on ONE chain: planned work reported as a failure would be worse
    // than not reporting it at all.
    expect(events.map((e) => e.kind).sort()).toEqual(['incident', 'maintenance']);
    expect(events.every((e) => e.chainId === 46630)).toBe(true);
  });

  it('ignores a chain operator\'s own status page — one source cannot promote itself', () => {
    const events = correlate([
      incident(ROBINHOOD[0]),
      incident(ROBINHOOD[1], { isProvider: false, statusPage: { id: 'robinhood', name: 'Robinhood', kind: 'chain' } })
    ]);
    expect(events).toEqual([]);
  });

  it('counts only ongoing reports', () => {
    const events = correlate([
      incident(ROBINHOOD[0]),
      incident(ROBINHOOD[1], { ongoing: false, status: 'resolved' })
    ]);
    expect(events).toEqual([]);
  });

  it('skips incidents whose chain cannot be resolved rather than grouping them together', () => {
    const events = correlate([
      incident(['infura', 'Elevated error rates in EU-West', 'investigating', '2026-07-30T06:00:00Z']),
      incident(['quicknode', 'Regional latency', 'investigating', '2026-07-30T06:10:00Z'])
    ]);
    expect(events).toEqual([]);
  });

  it('records that a group was corroborated by declared chains as well as titles', () => {
    const mixed = (it) => (it.statusPage.id === 'chainstack'
      ? { chainId: 46630, name: 'Robinhood Chain Testnet', evidence: 'declared', query: null }
      : resolve(it));
    const events = correlateChainIncidents([incident(ROBINHOOD[0]), incident(ROBINHOOD[1])], { resolve: mixed });
    expect(events[0].chainEvidence).toEqual(['declared', 'title']);
  });

  it('ranks the most corroborated chain first', () => {
    const other = (it) => (/robinhood testnet/i.test(it.title)
      ? { chainId: 46630, name: 'Robinhood Chain Testnet', evidence: 'title', query: 'x' }
      : { chainId: 137, name: 'Polygon Mainnet', evidence: 'title', query: 'y' });
    const events = correlateChainIncidents([
      ...ROBINHOOD.map((r) => incident(r)),
      incident(['blockdaemon', 'Polygon degraded', 'investigating', '2026-07-30T10:00:00Z']),
      incident(['pinax', 'Polygon degraded', 'investigating', '2026-07-30T10:05:00Z'])
    ], { resolve: other });
    expect(events.map((e) => [e.chainId, e.providerCount])).toEqual([[46630, 3], [137, 2]]);
  });

  it('honours a raised threshold', () => {
    expect(correlate(ROBINHOOD.map((r) => incident(r)), { minProviders: 4 })).toEqual([]);
    expect(correlate(ROBINHOOD.map((r) => incident(r)), { minProviders: 3 })).toHaveLength(1);
  });

  it('is a no-op on empty or malformed input', () => {
    expect(correlateChainIncidents()).toEqual([]);
    expect(correlateChainIncidents([null, {}, { isProvider: true }], { resolve })).toEqual([]);
  });
});
