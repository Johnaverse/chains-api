import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The profile page's relation logic, run from public/profile.js itself.
const code = readFileSync(new URL('../../../public/profile.js', import.meta.url), 'utf8');
const context = vm.createContext({ state: { byId: new Map(), l2beat: new Map() } });
vm.runInContext(`${code}; this.api = { relationRolesOf };`, context);
const { relationRolesOf } = context.api;

describe('relationRolesOf', () => {
  // Ethereum (1) with OP (10) as an L2, Sepolia (11155111) as its testnet, and an L3 (999) on OP
  // stated from the child's side.
  const graph = {
    nodes: [{ chainId: 1, name: 'Ethereum' }, { chainId: 10, name: 'OP' }, { chainId: 11155111, name: 'Sepolia' }, { chainId: 999, name: 'L3' }],
    edges: [
      { from: 1, to: 10, kind: 'parentOf', source: 'theGraph' },
      { from: 10, to: 1, kind: 'l2Of', source: 'chains' },
      { from: 1, to: 11155111, kind: 'mainnetOf', source: 'chains' },
      { from: 999, to: 10, kind: 'l2Of', source: 'chains' }
    ]
  };

  it('names each direct neighbour by what it is to the centre', () => {
    const { direct } = relationRolesOf(graph, 1);
    expect(direct.get(10)).toMatchObject({ role: 'child', name: 'OP', source: 'theGraph' });
    expect(direct.get(11155111)).toMatchObject({ role: 'testnet' });
    expect(direct.size).toBe(2);
  });

  it('hangs a second hop off the neighbour it relates to', () => {
    const { second } = relationRolesOf(graph, 1);
    expect(second.get(999)).toMatchObject({ anchor: 10, role: 'child' });
  });

  it("reads the same edges from an L2's side", () => {
    const { direct, second } = relationRolesOf(graph, 10);
    expect(direct.get(1)).toMatchObject({ role: 'parent' });
    expect(direct.get(999)).toMatchObject({ role: 'child' });
    expect(second.get(11155111)).toMatchObject({ anchor: 1, role: 'testnet' });
  });
});
