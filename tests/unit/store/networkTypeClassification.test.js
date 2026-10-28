import { describe, it, expect } from 'vitest';
import { classifyNetworkTypes, rawEntriesByChainId } from '../../../src/store/indexer.js';
import { networkTypeClaims, resolveNetworkType } from '../../../src/domain/networkType.js';

const map = (entries) => new Map(entries.map((e) => [e.chainId, e]));

describe('classifyNetworkTypes', () => {
  it('learns test words from its own first pass, so hostnames count before any chain is tagged', () => {
    // "Zeta" qualifies two testnets by name; a third chain says nothing but its hosts.
    const chains = [
      { chainId: 1, name: 'Aa Zeta Testnet' },
      { chainId: 2, name: 'Bb Zeta Testnet' },
      { chainId: 3, name: 'Cc Network', rpc: ['https://rpc.zeta.cc.example'] }
    ];
    const indexed = { byChainId: Object.fromEntries(chains.map((c) => [c.chainId, { chainId: c.chainId, name: c.name, tags: [] }])) };
    const decided = classifyNetworkTypes(indexed, { chains: map(chains), chainlist: map([{ chainId: 3, isTestnet: false }]), theGraph: new Map() });
    expect(decided.get(3).isTestnet).toBe(true);
    expect(decided.get(3).decidedBy).toMatchObject({ source: 'endpoints', field: 'hosts', said: 'zeta' });
  });

  it('reads a parent\'s inferred type down a chain of parents', () => {
    // 20 is a testnet only by its own hosts; 21 is filed under 20, 22 under 21.
    const chains = [
      { chainId: 1, name: 'Aa Zeta Testnet' }, { chainId: 2, name: 'Bb Zeta Testnet' },
      { chainId: 20, name: 'Mid', rpc: ['https://zeta.mid.example'] },
      { chainId: 21, name: 'Leaf', parent: { type: 'L2', chain: 'eip155-20' } },
      { chainId: 22, name: 'Leaf2', parent: { type: 'L2', chain: 'eip155-21' } },
      { chainId: 30, name: 'Loop A', parent: { type: 'L2', chain: 'eip155-31' } },
      { chainId: 31, name: 'Loop B', parent: { type: 'L2', chain: 'eip155-30' } }
    ];
    const indexed = { byChainId: Object.fromEntries(chains.map((c) => [c.chainId, { chainId: c.chainId, name: c.name, tags: [] }])) };
    const decided = classifyNetworkTypes(indexed, { chains: map(chains), chainlist: new Map(), theGraph: new Map() });
    expect([20, 21, 22].map((id) => decided.get(id).isTestnet)).toEqual([true, true, true]);
    // A cycle ends; neither says anything, so neither is a test network.
    expect([30, 31].map((id) => decided.get(id).isTestnet)).toEqual([false, false]);
  });

  it('gives no parent hint across a cycle, so indexing and validation agree', () => {
    // A (testnet by its host) and B are each other's parent.
    const chains = [
      { chainId: 1, name: 'Aa Zeta Testnet' }, { chainId: 2, name: 'Bb Zeta Testnet' },
      { chainId: 40, name: 'A', rpc: ['https://zeta.a.example'], parent: { type: 'L2', chain: 'eip155-41' } },
      { chainId: 41, name: 'B', parent: { type: 'L2', chain: 'eip155-40' } }
    ];
    const raw = { chains: map(chains), chainlist: new Map(), theGraph: new Map() };
    const indexed = { byChainId: Object.fromEntries(chains.map((c) => [c.chainId, { chainId: c.chainId, name: c.name, tags: [] }])) };
    const decided = classifyNetworkTypes(indexed, raw);
    // Validation reads the claims with the shared context: the same answer for B.
    const again = resolveNetworkType(networkTypeClaims({ chains: raw.chains.get(41) }));
    expect(again.isTestnet).toBe(decided.get(41).isTestnet);
    expect(networkTypeClaims({ chains: raw.chains.get(41) }).some((c) => c.field === 'parent')).toBe(false);
  });

  it('leaves out the entries an identity conflict excluded', () => {
    const raw = rawEntriesByChainId(
      { chains: [{ chainId: 999, name: 'Wanchain Testnet' }], chainlist: [{ chainId: 999, name: 'HyperEVM' }], theGraph: { networks: [] } },
      [{ chainId: 999, excluded: ['chains'] }]
    );
    expect(raw.chains.has(999)).toBe(false);
    expect(raw.chainlist.get(999).name).toBe('HyperEVM');
  });
});
