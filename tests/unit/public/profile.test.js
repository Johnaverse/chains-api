import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The profile page's relation logic, run from public/profile.js itself.
const code = readFileSync(new URL('../../../public/profile.js', import.meta.url), 'utf8');
const context = vm.createContext({ state: { byId: new Map(), l2beat: new Map() } });
vm.runInContext(`${code}; this.api = { relationRolesOf, nextForkOf };`, context);
const { relationRolesOf, nextForkOf } = context.api;

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

describe('nextForkOf', () => {
  it('warns about the soonest upcoming fork, a dated one before one with only a height', () => {
    const forks = [
      { name: 'Done', phase: 'past', activationAt: '2026-01-01T00:00:00Z' },
      { name: 'Later', phase: 'upcoming', activationAt: '2026-12-01T00:00:00Z' },
      { name: 'Height', phase: 'upcoming', activationAt: null, activationBlock: 5000 },
      { name: 'Soon', phase: 'upcoming', activationAt: '2026-11-05T18:00:00Z' }
    ];
    expect(nextForkOf(forks).name).toBe('Soon');
    expect(nextForkOf(forks.filter(f => f.activationAt == null || f.phase === 'past')).name).toBe('Height');
    expect(nextForkOf([{ phase: 'past' }, { phase: 'unscheduled' }])).toBeNull();
  });
});

describe('hwValue', () => {
  const { hwValue } = (() => {
    const ctx = vm.createContext({ state: { byId: new Map(), l2beat: new Map() } });
    vm.runInContext(`${code}; this.api = { hwValue };`, ctx);
    return ctx.api;
  })();

  it('writes a requirement as the document states it, without repeating the unit', () => {
    expect(hwValue({ component: 'cpu', metric: 'cores', value: 2, unit: 'cores', qualifier: 'at_least' })).toBe('≥ 2 cores');
    expect(hwValue({ component: 'cpu', metric: 'threads', value: 16, unit: 'threads', qualifier: 'as_stated' })).toBe('16 threads');
    expect(hwValue({ component: 'storage', metric: 'iops', value: 50000, unit: 'IOPS', qualifier: 'at_least' })).toBe(`≥ ${(50000).toLocaleString()} IOPS`);
    expect(hwValue({ component: 'storage', metric: 'storage_type', value: 'NVMe SSD', unit: null, qualifier: 'as_stated' })).toBe('NVMe SSD');
    expect(hwValue({ component: 'network', metric: 'bandwidth', value: null, unit: 'Gbps', qualifier: 'range', min: 1, max: 10 })).toBe('1–10 Gbps');
    expect(hwValue({ component: 'storage', metric: 'bandwidth', value: 500, unit: 'MB/s', qualifier: 'at_least' })).toBe('bandwidth ≥ 500 MB/s');
    expect(hwValue({ component: 'network', metric: 'public_ip', value: true, qualifier: 'as_stated' })).toBe('public ip');
  });
});

describe('hwProfile', () => {
  it('shows every component a profile carries, known ones first', () => {
    const doc = { createElement: tag => ({ tag, children: [], className: '', textContent: '', setAttribute() {}, appendChild(c) { this.children.push(c); return c; }, addEventListener() {}, classList: { add() {} } }), createTextNode: t => ({ textContent: t }) };
    const ctx = vm.createContext({ state: { byId: new Map(), l2beat: new Map() }, document: doc, Node: Object });
    vm.runInContext(`function el(tag, props = {}, children = []) { const n = { tag, props, children: [].concat(children).filter(c => c != null) }; return n; }
      function extLink(u, t) { return el('a', { text: t }); } function safeHost(u) { return u; }
      ${code}; this.api = { hwProfile };`, ctx);
    const node = ctx.api.hwProfile({ role: 'full_node', level: 'minimum', requirements: [
      { component: 'os', metric: 'os_version', value: 'Linux', qualifier: 'as_stated' },
      { component: 'gpu', metric: 'vram', value: 8, unit: 'GB', qualifier: 'at_least' },
      { component: 'cpu', metric: 'cores', value: 4, unit: 'cores', qualifier: 'as_stated' }
    ] }, false);
    const labels = node.children.filter(c => c?.props?.class === 'pf-hw-row').map(r => r.children[0].props.text);
    expect(labels).toEqual(['CPU', 'GPU', 'OS']);
  });
});
