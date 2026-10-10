import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadNetworkResearch,
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
    { chainId: 8453, family: 'duplicate ignored', repositories: [], papers: [], features: [] },
    { chainId: 'nope' }
  ]
};

let dir;
const write = (name, content) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'research-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  _setNetworkResearchForTests();
});

afterEach(() => {
  _setNetworkResearchForTests(write('dataset.json', JSON.stringify(DATASET)));
  cachedData.indexed = null;
  _resetGetAllChainsCacheForTests();
});

describe('loadNetworkResearch', () => {
  it('indexes networks by chainId, first entry wins, invalid ids skipped', () => {
    const { updatedAt, byChainId } = loadNetworkResearch(write('a.json', JSON.stringify(DATASET)));
    expect(updatedAt).toBe('2026-10-10T07:58:00.646Z');
    expect([...byChainId.keys()]).toEqual([8453, 7, 327]);
    expect(byChainId.get(8453).family).toBe('OP Stack-derived');
  });

  it('returns an empty dataset for a missing or malformed file', () => {
    expect(loadNetworkResearch(join(dir, 'missing.json')).byChainId.size).toBe(0);
    const bad = loadNetworkResearch(write('bad.json', '{not json'));
    expect(bad).toEqual({ updatedAt: null, byChainId: new Map() });
    expect(loadNetworkResearch(write('shape.json', JSON.stringify({ networks: 'x' }))).byChainId.size).toBe(0);
  });

  it('loads the checked-in dataset', () => {
    const { updatedAt, byChainId } = loadNetworkResearch();
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(byChainId.size).toBeGreaterThan(2000);
    expect(byChainId.get(1).family).toBe('Ethereum');
  });
});

describe('getNetworkResearch / getNetworkResearchInfo', () => {
  it('returns the research block without chainId or websiteCorrection, dated by the dataset', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    expect(getNetworkResearch('8453')).toEqual({
      family: 'OP Stack-derived',
      coverage: 'partial',
      auditStatus: 'qualified',
      checkedAt: '2026-10-10T07:50:19Z',
      repositories: [repo],
      papers: [],
      features: [],
      updatedAt: '2026-10-10T07:58:00.646Z'
    });
    expect(getNetworkResearch(424242)).toBeNull();
    expect(getNetworkResearchInfo()).toEqual({ loaded: true, updatedAt: '2026-10-10T07:58:00.646Z', networks: 3 });
  });

  it('returns null when the research lists no repositories, papers or features', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    expect(getNetworkResearch(7)).toBeNull();
    expect(getNetworkResearch(327)).toBeNull();
  });

  it('returns a copy, so callers cannot mutate the dataset', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    getNetworkResearch(8453).repositories.push({ url: 'https://evil.example' });
    expect(getNetworkResearch(8453).repositories).toEqual([repo]);
  });

  it('reports not loaded when the dataset is empty', () => {
    _setNetworkResearchForTests(join(dir, 'missing.json'));
    expect(getNetworkResearchInfo()).toEqual({ loaded: false, updatedAt: null, networks: 0 });
  });
});

describe('attachNetworkResearch', () => {
  const indexed = chains => ({ byChainId: Object.fromEntries(chains.map(c => [c.chainId, { sources: ['chains'], ...c }])) });

  it('stamps family and the research source; leaves unknown chains alone', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    const idx = indexed([{ chainId: 8453, infoURL: 'https://base.org' }, { chainId: 1 }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[8453]).toMatchObject({ family: 'OP Stack-derived', sources: ['chains', 'research'], infoURL: 'https://base.org' });
    expect(idx.byChainId[8453].infoURLSource).toBeUndefined();
    expect(idx.byChainId[1]).toEqual({ chainId: 1, sources: ['chains'] });
  });

  it('creates sources when missing and skips a null family', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    const idx = { byChainId: { 327: { chainId: 327, infoURL: 'https://other.example' } } };
    attachNetworkResearch(idx);
    expect(idx.byChainId[327].sources).toEqual(['research']);
    expect('family' in idx.byChainId[327]).toBe(false);
  });

  it('replaces infoURL while the registry still lists the replaced website (normalised)', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    const idx = indexed([{ chainId: 7, infoURL: 'https://thaichain.io' }, { chainId: 327 }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[7]).toMatchObject({ infoURL: 'https://thaichain.org/', registryInfoURL: 'https://thaichain.io', infoURLSource: 'research' });
    expect(idx.byChainId[327]).toMatchObject({ infoURL: 'https://onyx.org/', registryInfoURL: null, infoURLSource: 'research' });
  });

  it('never treats two unparseable websites as the same, nor a null `replaces` as matching a malformed one', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    const idx = indexed([{ chainId: 7, infoURL: 'thaichain.io' }, { chainId: 327, infoURL: 'onyx.org' }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[7].infoURL).toBe('thaichain.io');
    expect(idx.byChainId[327].infoURL).toBe('onyx.org');
    expect(idx.byChainId[327].infoURLSource).toBeUndefined();
  });

  it('keeps an infoURL the registry has since changed', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
    const idx = indexed([{ chainId: 7, infoURL: 'https://thaichain.network' }, { chainId: 327, infoURL: 'https://onyx.example' }]);
    attachNetworkResearch(idx);
    expect(idx.byChainId[7].infoURL).toBe('https://thaichain.network');
    expect(idx.byChainId[327].infoURL).toBe('https://onyx.example');
    expect(idx.byChainId[7].infoURLSource).toBeUndefined();
  });

  it('is idempotent', () => {
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
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
    _setNetworkResearchForTests(write('d.json', JSON.stringify(DATASET)));
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
    expect(getChainDetail(8453).research).toMatchObject({ family: 'OP Stack-derived', repositories: [repo] });
    expect(getChainDetail(999)).toEqual(getChainById(999));
    expect(getChainDetail(424242)).toBeNull();
  });
});
