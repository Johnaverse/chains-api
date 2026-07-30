import { describe, expect, it, vi } from 'vitest';
import { chainQueriesFromIncident, resolveIncidentChain, CHAIN_EVIDENCE } from '../../../src/domain/incidentChains.js';

// A stand-in registry. searchChains itself is tested in tests/unit/store; what
// matters here is WHICH queries this module offers it, and in what order.
const REGISTRY = {
  'robinhood testnet': [{ chainId: 46630, name: 'Robinhood Chain Testnet' }],
  robinhood: [{ chainId: 4663, name: 'Robinhood Chain' }, { chainId: 46630, name: 'Robinhood Chain Testnet' }],
  'scroll sepolia': [{ chainId: 534351, name: 'Scroll Sepolia Testnet' }],
  'solana mainnet': [],
  sepolia: Array.from({ length: 30 }, (_, i) => ({ chainId: 1000 + i, name: `Sepolia lookalike ${i}` }))
};
const search = vi.fn((q) => REGISTRY[q.toLowerCase()] ?? []);

const incident = (over = {}) => ({ title: 'Robinhood Testnet Global Outage', chains: [], networkNames: [], ...over });

describe('chainQueriesFromIncident', () => {
  it('offers the longest leading phrase first, so a testnet is not read as its mainnet', () => {
    const queries = chainQueriesFromIncident(incident());
    expect(queries[0]).toBe('Robinhood Testnet Global Outage');
    // "Robinhood Testnet" MUST come before the bare "Robinhood": the bare name
    // matches the mainnet chain, and first-resolving-wins would then attribute a
    // testnet outage to mainnet.
    expect(queries.indexOf('Robinhood Testnet')).toBeLessThan(queries.indexOf('Robinhood'));
  });

  it('puts the feed\'s own extraction ahead of any leading phrase', () => {
    // The feed reaches positions a leading scan cannot — here, after a preposition.
    const queries = chainQueriesFromIncident({
      title: 'Degraded Performance for Solana Mainnet in the LAX Region',
      networkNames: ['Solana Mainnet']
    });
    expect(queries[0]).toBe('Solana Mainnet');
  });

  it('reads a bracketed label as the chain, not as noise', () => {
    // "*URGENT* [SUI] - Mainnet upgrade" carries its chain ONLY in the label.
    // Stripping labels as severity noise found nothing at all here.
    expect(chainQueriesFromIncident({ title: '*URGENT* [SUI] - Mainnet upgrade' })).toContain('SUI');
    expect(chainQueriesFromIncident({ title: '[Canton] - Devnet Outage' })).toContain('Canton');
  });

  it('drops the urgency marker but keeps the chain phrase after it', () => {
    const queries = chainQueriesFromIncident({ title: '[Urgent] Sui - Mainnet - Upgrade to v1.76.1' });
    // "Urgent" is a severity label and must not become a chain query.
    expect(queries).not.toContain('Urgent');
    expect(queries.some(q => /^Sui/.test(q))).toBe(true);
  });

  it('never probes the registry with words that cannot name a chain', () => {
    // Without this guard "node" substring-matches a long tail of unrelated chains.
    expect(chainQueriesFromIncident({ title: 'JSON-RPC API Degraded' })).toEqual([]);
    expect(chainQueriesFromIncident({ title: 'Scheduled maintenance for the node network' })).toEqual([]);
  });

  it('ignores an empty or missing title without throwing', () => {
    expect(chainQueriesFromIncident({})).toEqual([]);
    expect(chainQueriesFromIncident()).toEqual([]);
  });
});

describe('resolveIncidentChain', () => {
  it('resolves the reported case: three-word incident prose to the testnet chain', () => {
    const resolved = resolveIncidentChain(incident(), { search });
    expect(resolved).toMatchObject({ chainId: 46630, evidence: 'title', query: 'Robinhood Testnet' });
  });

  it('prefers a chain the provider declared over anything read from the title', () => {
    const resolved = resolveIncidentChain(incident({ chains: [{ chainId: 137, name: 'Polygon Mainnet' }] }), { search });
    expect(resolved).toMatchObject({ chainId: 137, evidence: 'declared' });
    expect(CHAIN_EVIDENCE).toContain(resolved.evidence);
  });

  it('resolves a testnet variant to the testnet chain, not the mainnet lookalike', () => {
    const resolved = resolveIncidentChain(
      { title: 'Scroll Sepolia HTTPS JSON-RPC API partial outage', chains: [], networkNames: [] }, { search }
    );
    // A hand-rolled matcher got this wrong first time, resolving it to Scroll mainnet.
    expect(resolved.chainId).toBe(534351);
  });

  it('refuses an ambiguous candidate rather than naming one of thirty chains', () => {
    const resolved = resolveIncidentChain({ title: 'Sepolia degraded', chains: [], networkNames: [] }, { search });
    expect(resolved).toBeNull();
  });

  it('returns null when nothing resolves — a chain nobody named must not be invented', () => {
    expect(resolveIncidentChain({ title: 'Elevated error rates in EU-West', chains: [], networkNames: [] }, { search })).toBeNull();
  });

  it('survives a resolver that throws', () => {
    const boom = () => { throw new Error('registry not loaded'); };
    expect(resolveIncidentChain(incident(), { search: boom })).toBeNull();
  });
});
