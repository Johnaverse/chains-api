import { describe, it, expect } from 'vitest';
import { classifyNetworkTypes } from '../../../src/store/indexer.js';

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
});
