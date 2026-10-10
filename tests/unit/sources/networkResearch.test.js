import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadNetworkResearch,
  loadForumResearch,
  loadNodeHardware,
  getNetworkResearch,
  getNetworkResearchInfo,
  attachNetworkResearch,
  _setNetworkResearchForTests
} from '../../../src/sources/networkResearch.js';
import { indexData } from '../../../src/store/indexer.js';
import { cachedData } from '../../../src/store/cache.js';
import { getChainById, getChainDetail, searchChains, getAllChains, _resetGetAllChainsCacheForTests } from '../../../src/store/queries.js';

const repo = { url: 'https://github.com/base/base', repo: 'base/base', kind: 'rollup', kindLabel: 'x', status: 'checked', audit: 'confirmed', evidence: [] };

const DATASET = {
  updatedAt: '2026-10-10T07:58:00.646Z',
  networks: [
    { chainId: 8453, family: 'OP Stack-derived', websiteCorrection: null, coverage: 'partial', auditStatus: 'qualified', checkedAt: '2026-10-10T07:50:19Z', repositories: [repo], papers: [], features: [] },
    { chainId: 7, family: 'ThaiChain', websiteCorrection: { website: 'https://thaichain.org/', replaces: 'https://thaichain.io/' }, repositories: [], papers: [], features: [] },
    { chainId: 327, family: null, websiteCorrection: { website: 'https://onyx.org/', replaces: null }, repositories: [], papers: [], features: [] },
    { chainId: 99, family: null, websiteCorrection: { website: 'https://fixed.example/', replaces: 'junk' }, repositories: [], papers: [], features: [] },
    { chainId: 8453, family: 'duplicate ignored', repositories: [], papers: [], features: [] },
    { chainId: 'nope' }
  ]
};

const forum = {
  url: 'https://forum.arbitrum.foundation/', title: 'Arbitrum DAO Governance Forum', type: 'governance', relationship: 'official',
  scope: 'project_family', access: 'read', activity: 'recent_activity_observed', lastActivity: '2026-10-09',
  verification: 'confirmed', notes: 'Official docs link it.', evidence: ['https://docs.arbitrum.io/']
};

const FORUMS = {
  updatedAt: '2026-10-10T15:51:28.230185+00:00',
  networks: [
    { chainId: 4242, status: 'found', checkedAt: '2026-10-10T15:07:54.328Z', forums: [forum] },
    { chainId: 8453, status: 'found', checkedAt: '2026-10-10T15:00:00.000Z', forums: [{ ...forum, url: 'https://github.com/base/web/discussions', access: 'archived' }] },
    { chainId: 777, status: 'partial', checkedAt: null, forums: [] },
    { chainId: 4242, forums: [{ ...forum, title: 'duplicate ignored' }] }
  ]
};

const profile = {
  id: 'full-minimum', role: 'full_node', level: 'minimum', scope: 'exact_network', client: 'Base Reth', clientVersion: null,
  deployment: 'current', verification: 'confirmed', notes: null, verificationNotes: 'Values match.',
  evidence: ['https://docs.base.org/'],
  requirements: [
    { component: 'cpu', metric: 'cores', value: 8, unit: 'cores', qualifier: 'at_least', source: 'https://docs.base.org/node' },
    { component: 'memory', metric: 'capacity', value: 16, unit: 'GiB', qualifier: 'as_stated', source: 'https://docs.base.org/node' },
    { component: 'storage', metric: 'capacity', value: null, min: 2, max: 4, unit: 'TB', qualifier: 'range', notes: 'grows', source: 'https://docs.base.org/node' }
  ]
};

const HARDWARE = {
  updatedAt: '2026-10-10T16:20:12.747009+00:00',
  networks: [
    { chainId: 8453, status: 'documented', identityStatus: 'confirmed', checkedAt: '2026-10-10T09:27:13.772253+00:00', profiles: [profile] },
    { chainId: 5151, status: 'partial', identityStatus: 'qualified', checkedAt: null, profiles: [{ ...profile, scope: 'project_family', verification: 'qualified' }] },
    { chainId: 777, status: 'partial', identityStatus: 'unresolved', checkedAt: null, profiles: [] },
    { chainId: 8453, profiles: [{ ...profile, id: 'duplicate ignored' }] }
  ]
};

let dir;
const write = (name, content) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};
const useFixtures = () => _setNetworkResearchForTests(
  write('dataset.json', JSON.stringify(DATASET)),
  write('forums.json', JSON.stringify(FORUMS)),
  write('hardware.json', JSON.stringify(HARDWARE))
);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  _setNetworkResearchForTests();
});

afterEach(() => {
  useFixtures();
  cachedData.indexed = null;
  _resetGetAllChainsCacheForTests();
});

describe('loadNetworkResearch', () => {
  it('indexes networks by chainId, first entry wins, invalid ids skipped', () => {
    const { updatedAt, byChainId } = loadNetworkResearch(write('a.json', JSON.stringify(DATASET)));
    expect(updatedAt).toBe('2026-10-10T07:58:00.646Z');
    expect([...byChainId.keys()]).toEqual([8453, 7, 327, 99]);
    expect(byChainId.get(8453).family).toBe('OP Stack-derived');
  });

  it('returns an empty dataset for a missing or malformed file', () => {
    expect(loadNetworkResearch(join(dir, 'missing.json')).byChainId.size).toBe(0);
    const bad = loadNetworkResearch(write('bad.json', '{not json'));
    expect(bad).toEqual({ updatedAt: null, byChainId: new Map() });
    expect(loadNetworkResearch(write('shape.json', JSON.stringify({ networks: 'x' }))).byChainId.size).toBe(0);
  });

  it('loads the checked-in datasets', () => {
    const { updatedAt, byChainId } = loadNetworkResearch();
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byChainId.size).toBeGreaterThan(2000);
    expect(byChainId.get(1).family).toBe('Ethereum');

    const forums = loadForumResearch();
    expect(forums.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(forums.byChainId.size).toBeGreaterThan(500);
    expect(forums.byChainId.get(1).forums.map(f => f.url)).toContain('https://ethereum-magicians.org/');
    // Every kept record was independently confirmed or qualified, and still a forum.
    for (const entry of forums.byChainId.values()) {
      for (const f of entry.forums) {
        expect(['confirmed', 'qualified']).toContain(f.verification);
        expect(f.access).not.toBe('repurposed');
      }
    }

    const hardware = loadNodeHardware();
    expect(hardware.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(hardware.byChainId.size).toBeGreaterThan(700);
    const ethereum = hardware.byChainId.get(1);
    expect(ethereum.identityStatus).toBe('confirmed');
    const minimum = ethereum.profiles.find(p => p.role === 'full_node' && p.level === 'minimum');
    // Units stay exactly as published: ethereum.org says 16 GB and 25 MBit/s, so that is what is served.
    expect(minimum.requirements).toContainEqual(expect.objectContaining({ component: 'memory', metric: 'capacity', value: 16, unit: 'GB' }));
    expect(minimum.requirements).toContainEqual(expect.objectContaining({ component: 'network', metric: 'bandwidth', value: 25, unit: 'MBit/s', qualifier: 'at_least' }));
    for (const entry of hardware.byChainId.values()) {
      expect(entry.profiles.length).toBeGreaterThan(0);
      for (const p of entry.profiles) {
        expect(['confirmed', 'qualified']).toContain(p.verification);
        expect(p.requirements.length).toBeGreaterThan(0);
        for (const r of p.requirements) expect(r.value != null || r.min != null || r.max != null).toBe(true);
      }
    }
  });
});

describe('getNetworkResearch / getNetworkResearchInfo', () => {
  it('returns the research block without chainId or websiteCorrection, dated by the dataset', () => {
    expect(getNetworkResearch('8453')).toEqual({
      family: 'OP Stack-derived',
      coverage: 'partial',
      auditStatus: 'qualified',
      checkedAt: '2026-10-10T07:50:19Z',
      repositories: [repo],
      papers: [],
      features: [],
      forums: [{ ...forum, url: 'https://github.com/base/web/discussions', access: 'archived' }],
      forumsCheckedAt: '2026-10-10T15:00:00.000Z',
      hardware: { identityStatus: 'confirmed', checkedAt: '2026-10-10T09:27:13.772253+00:00', profiles: [profile] },
      updatedAt: '2026-10-10T07:58:00.646Z'
    });
    expect(getNetworkResearch(424242)).toBeNull();
    expect(getNetworkResearchInfo()).toEqual({
      loaded: true,
      researchLoaded: true, updatedAt: '2026-10-10T07:58:00.646Z', networks: 4,
      forumsLoaded: true, forumNetworks: 3, forumsUpdatedAt: '2026-10-10T15:51:28.230185+00:00',
      hardwareLoaded: true, hardwareNetworks: 3, hardwareUpdatedAt: '2026-10-10T16:20:12.747009+00:00'
    });
  });

  it('returns a forums-only block for a chain the network research did not cover, dated by the forum dataset', () => {
    expect(getNetworkResearch(4242)).toEqual({ forums: [forum], forumsCheckedAt: '2026-10-10T15:07:54.328Z', updatedAt: '2026-10-10T15:51:28.230185+00:00' });
  });

  it('returns a hardware-only block, dated by the hardware dataset when the network has no check date', () => {
    expect(getNetworkResearch(5151)).toEqual({
      hardware: {
        identityStatus: 'qualified',
        checkedAt: '2026-10-10T16:20:12.747009+00:00',
        profiles: [{ ...profile, scope: 'project_family', verification: 'qualified' }]
      },
      updatedAt: '2026-10-10T16:20:12.747009+00:00'
    });
  });

  it('reports research as not loaded when any one dataset is missing, with the flag naming which', () => {
    _setNetworkResearchForTests(write('dataset.json', JSON.stringify(DATASET)), join(dir, 'missing.json'), write('hardware.json', JSON.stringify(HARDWARE)));
    expect(getNetworkResearchInfo()).toMatchObject({ loaded: false, researchLoaded: true, forumsLoaded: false, hardwareLoaded: true, forumNetworks: 0 });
    _setNetworkResearchForTests(write('dataset.json', JSON.stringify(DATASET)), write('forums.json', JSON.stringify(FORUMS)), join(dir, 'missing.json'));
    expect(getNetworkResearchInfo()).toMatchObject({ loaded: false, hardwareLoaded: false, hardwareNetworks: 0 });
  });

  it('returns null when the research lists no repositories, papers, features, forums or hardware', () => {
    expect(getNetworkResearch(7)).toBeNull();
    expect(getNetworkResearch(327)).toBeNull();
    expect(getNetworkResearch(777)).toBeNull();
  });

  it('returns a copy, so callers cannot mutate the datasets', () => {
    getNetworkResearch(8453).repositories.push({ url: 'https://evil.example' });
    getNetworkResearch(4242).forums[0].url = 'https://evil.example';
    getNetworkResearch(5151).hardware.profiles[0].requirements[0].value = 999;
    expect(getNetworkResearch(8453).repositories).toEqual([repo]);
    expect(getNetworkResearch(4242).forums).toEqual([forum]);
    expect(getNetworkResearch(5151).hardware.profiles[0].requirements[0].value).toBe(8);
  });

  it('reports not loaded when the datasets are empty', () => {
    _setNetworkResearchForTests(join(dir, 'missing.json'), join(dir, 'missing.json'), join(dir, 'missing.json'));
    expect(getNetworkResearchInfo()).toEqual({
      loaded: false,
      researchLoaded: false, updatedAt: null, networks: 0,
      forumsLoaded: false, forumNetworks: 0, forumsUpdatedAt: null,
      hardwareLoaded: false, hardwareNetworks: 0, hardwareUpdatedAt: null
    });
    expect(getNetworkResearch(8453)).toBeNull();
    expect(getNetworkResearch(5151)).toBeNull();
  });
});

describe('attachNetworkResearch', () => {
  const indexed = chains => ({ byChainId: Object.fromEntries(chains.map(c => [c.chainId, { sources: ['chains'], ...c }])) });

  it('stamps family and the research source; leaves unknown chains alone', () => {
    useFixtures();
    const idx = indexed([{ chainId: 8453, infoURL: 'https://base.org' }, { chainId: 1 }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[8453]).toMatchObject({ family: 'OP Stack-derived', sources: ['chains', 'research'], infoURL: 'https://base.org' });
    expect(idx.byChainId[8453].infoURLSource).toBeUndefined();
    expect(idx.byChainId[1]).toEqual({ chainId: 1, sources: ['chains'] });
  });

  it('creates sources when missing and skips a null family', () => {
    const idx = { byChainId: { 327: { chainId: 327, infoURL: 'https://other.example' } } };
    attachNetworkResearch(idx);
    expect(idx.byChainId[327].sources).toEqual(['research']);
    expect('family' in idx.byChainId[327]).toBe(false);
  });

  it('marks a chain covered only by the forum or hardware research, without stamping anything else', () => {
    const idx = indexed([{ chainId: 4242, forumUrl: 'https://forum.arbitrum.foundation' }, { chainId: 777 }, { chainId: 5151 }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[4242]).toEqual({ chainId: 4242, forumUrl: 'https://forum.arbitrum.foundation', sources: ['chains', 'research'] });
    expect(idx.byChainId[5151]).toEqual({ chainId: 5151, sources: ['chains', 'research'] });
    // Listed in the exports with nothing kept: still researched, nothing else.
    expect(idx.byChainId[777].sources).toEqual(['chains', 'research']);
  });

  it('replaces infoURL while the registry still lists the replaced website (normalised)', () => {
    useFixtures();
    const idx = indexed([{ chainId: 7, infoURL: 'https://thaichain.io' }, { chainId: 327 }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[7]).toMatchObject({ infoURL: 'https://thaichain.org/', registryInfoURL: 'https://thaichain.io', infoURLSource: 'research' });
    expect(idx.byChainId[327]).toMatchObject({ infoURL: 'https://onyx.org/', registryInfoURL: null, infoURLSource: 'research' });
  });

  it('never treats two unparseable websites as the same, nor a null `replaces` as matching a malformed one', () => {
    useFixtures();
    const idx = indexed([{ chainId: 7, infoURL: 'thaichain.io' }, { chainId: 327, infoURL: 'onyx.org' }, { chainId: 99, infoURL: 'junk' }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[7].infoURL).toBe('thaichain.io');
    expect(idx.byChainId[327].infoURL).toBe('onyx.org');
    expect(idx.byChainId[327].infoURLSource).toBeUndefined();
    expect(idx.byChainId[99].infoURL).toBe('junk');
  });

  it('keeps an infoURL the registry has since changed', () => {
    useFixtures();
    const idx = indexed([{ chainId: 7, infoURL: 'https://thaichain.network' }, { chainId: 327, infoURL: 'https://onyx.example' }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[7].infoURL).toBe('https://thaichain.network');
    expect(idx.byChainId[327].infoURL).toBe('https://onyx.example');
    expect(idx.byChainId[7].infoURLSource).toBeUndefined();
  });

  it('is idempotent', () => {
    useFixtures();
    const idx = indexed([{ chainId: 7, infoURL: 'https://thaichain.io' }, { chainId: 327 }]);
    attachNetworkResearch(idx);
    const once = structuredClone(idx);
    attachNetworkResearch(idx);
    expect(idx).toEqual(once);
  });

  it('ignores a missing index', () => {
    expect(() => attachNetworkResearch(null)).not.toThrow();
    expect(() => attachNetworkResearch({})).not.toThrow();
  });
});

describe('queries — research reaches the API projections', () => {
  const load = () => {
    useFixtures();
    cachedData.indexed = indexData(null, null, [
      { chainId: 8453, name: 'Base', infoURL: 'https://base.org' },
      { chainId: 7, name: 'ThaiChain', infoURL: 'https://thaichain.io' },
      { chainId: 999, name: 'Unresearched' }
    ], null);
    _resetGetAllChainsCacheForTests();
  };

  it('getChainById and getAllChains carry family and the website correction, not the research block', () => {
    load();
    expect(getChainById(8453)).toMatchObject({ family: 'OP Stack-derived', infoURL: 'https://base.org' });
    expect(getChainById(8453).infoURLSource).toBeUndefined();
    expect(getChainById(7)).toMatchObject({ infoURL: 'https://thaichain.org/', infoURLSource: 'research', registryInfoURL: 'https://thaichain.io' });
    expect(getChainById(8453).research).toBeUndefined();
    expect(getAllChains().some(c => 'research' in c)).toBe(false);
    expect(searchChains('Base').some(c => 'research' in c)).toBe(false);
  });

  it('getChainDetail adds the research block when there is one', () => {
    load();
    expect(getChainDetail(8453).research).toMatchObject({
      family: 'OP Stack-derived', repositories: [repo], forums: [expect.objectContaining({ access: 'archived' })],
      hardware: { identityStatus: 'confirmed', profiles: [expect.objectContaining({ role: 'full_node' })] }
    });
    expect(getChainDetail(999)).toEqual(getChainById(999));
    expect(getChainDetail(424242)).toBeNull();
  });

  it('forum research never becomes the chain forumUrl that chains-forum-news polls', () => {
    load();
    cachedData.indexed = indexData(null, null, [{ chainId: 4242, name: 'Unregistered' }], null);
    _resetGetAllChainsCacheForTests();
    expect(getChainById(4242).forumUrl).toBeUndefined();
    expect(getChainDetail(4242).research.forums).toEqual([forum]);
    expect(getAllChains().some(c => 'research' in c)).toBe(false);
    // Base: the curated registry's forum stays the forumUrl; the research board is separate.
    load();
    expect(getChainById(8453).forumUrl).toBe('https://gov.optimism.io');
    expect(getChainDetail(8453).research.forums.map(f => f.url)).toEqual(['https://github.com/base/web/discussions']);
  });
});
