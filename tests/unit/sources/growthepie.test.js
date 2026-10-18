import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFeed } from '../../../src/sources/feedHttp.js';

vi.mock('../../../src/sources/feedHttp.js', () => ({ getFeed: vi.fn() }));

const G = await import('../../../src/sources/growthepie.js');

import { MASTER, FUNDAMENTALS, FEES, LANDING, ECONOMICS, BLOCKSPACE, DA, ETH_SUPPLY, BODIES } from '../../fixtures/growthepie.js';

const ok = body => ({ ok: true, status: 200, json: async () => body });
const pathOf = url => url.replace(/^https?:\/\/[^/]+\/v1\//, '');
const serveAll = (overrides = {}) => getFeed.mockImplementation(async url => {
  const path = pathOf(url);
  if (path in overrides) return overrides[path];
  return ok(BODIES[path]);
});

beforeEach(() => {
  getFeed.mockReset();
  G._setGrowthepieForTests({});
});

describe('normalizers', () => {
  it('master: profile per origin key with the EVM chain ID, stack, L2BEAT stage and growthepie URL', () => {
    const m = G.normalizeMaster(MASTER);
    expect(m.chains.base).toMatchObject({
      chainId: 8453, name: 'Base', url: 'https://www.growthepie.com/chains/base', stack: { label: 'OP Stack, Superchain' },
      daLayer: 'Ethereum (blobs)', l2beat: { stage: 'Stage 1', id: 'base' }, explorers: [{ name: 'Basescan', url: 'https://basescan.org' }]
    });
    expect(m.chains.starknet).toMatchObject({ chainId: null, l2beat: { stage: 'Stage 1' } });
    expect(m.metrics.daa).toMatchObject({ name: 'Active Addresses', metricKeys: ['daa'], url: 'https://www.growthepie.com/fundamentals/daily-active-addresses' });
    expect(m.categories).toEqual({ finance: 'Finance', social: 'Social' });
  });

  it('fundamentals: ascending daily series per metric, bad rows dropped, capped to the last N days', () => {
    const f = G.normalizeFundamentals(FUNDAMENTALS, { days: 30 });
    expect(f.base.txcount).toHaveLength(30);
    expect(f.base.txcount.at(-1)).toEqual(['2026-10-16', 1600]);
    expect(f.base.txcount[0][0] < f.base.txcount[1][0]).toBe(true);
    expect(f.ethereum.daa).toEqual([['2026-10-16', 400000]]);
  });

  it('fees: the newest hourly reading per metric, in USD/ETH or as a plain value', () => {
    expect(G.normalizeFees(FEES).base).toEqual({
      txcosts_median: { at: new Date(1792159200000).toISOString(), usd: 0.0018, eth: 7e-7 },
      tps: { at: new Date(1792159200000).toISOString(), value: 156 }
    });
  });

  it('landing: users and ranks per chain, and the all-L2 daily series keyed like fundamentals', () => {
    const l = G.normalizeLanding(LANDING);
    expect(l.chains.base).toEqual({ users: 1434291, userShare: 0.0952, crossChainActivity: 0.1, ranking: { txcount: { rank: 1, outOf: 26 }, tvl: { rank: 1, outOf: 26 } } });
    expect(l.aggregates.all_l2s.txcount.map(p => p[0])).toEqual(['2026-10-14', '2026-10-15']);
    expect(l.aggregates.all_l2s.rent_paid_usd).toEqual([['2026-10-15', 1946.96]]);
  });

  it('economics: revenue, L1 and blob costs, profit and margin per span; non-span keys ignored', () => {
    const e = G.normalizeEconomics(ECONOMICS).base;
    expect(Object.keys(e)).toEqual(['30d']);
    expect(e['30d']).toEqual({
      revenueUsd: 2927063.9, revenueEth: 1121.5, costsUsd: 18899.9, costsEth: 7.2, costsL1Usd: 15822.1, costsBlobsUsd: 3077.8,
      profitUsd: 2908164, profitEth: 1114.4, profitMargin: 0.9936, dataPostedBytes: 38318000991
    });
  });

  it('blockspace: gas fees and transactions per category per span', () => {
    const b = G.normalizeBlockspace(BLOCKSPACE).base;
    expect(b['30d'].finance).toEqual({ gasFeesUsd: 250000, gasFeesEth: 100, txcount: 90000000, gasFeesShareUsd: 0.41, txcountShare: 0.35 });
    expect(Object.keys(b)).toEqual(['7d', '30d']);
  });

  it('DA: per layer fees, data posted and consumers; the totals row is not a layer', () => {
    const d = G.normalizeDa(DA);
    expect(Object.keys(d.layers)).toEqual(['da_ethereum_blobs']);
    expect(d.layers.da_ethereum_blobs['30d']).toMatchObject({ feesUsd: 9306.7, dataPostedBytes: 114803381802, feesPerMbUsd: 0.085, consumerCount: 42 });
    expect(d.layers.da_ethereum_blobs['30d'].consumers).toEqual([{ key: 'base', name: 'Base', originKey: 'base' }, { key: 'blast', name: 'Blast', originKey: null }]);
    expect(d.topConsumers['30d'][0]).toEqual({ key: 'base', name: 'Base', daLayer: 'NA', originKey: 'base', dataPostedBytes: 38318000991 });
  });

  it('ETH supply: latest supply and issuance by date, with the events', () => {
    const e = G.normalizeEthSupply(ETH_SUPPLY);
    expect(e.supply).toEqual({ date: '2026-10-16', value: 122132893.75 });
    expect(e.issuanceRate).toEqual({ date: '2026-10-16', value: 0.0072 });
    expect(e.events[0]).toMatchObject({ date: '2015-07-30', title: 'Genesis Block' });
  });

  it('tolerates missing or malformed bodies instead of throwing', () => {
    for (const fn of [G.normalizeMaster, G.normalizeFundamentals, G.normalizeFees, G.normalizeLanding, G.normalizeEconomics, G.normalizeBlockspace, G.normalizeDa, G.normalizeEthSupply]) {
      expect(() => fn(null)).not.toThrow();
      expect(() => fn({ data: 'nope' })).not.toThrow();
    }
  });
});

describe('reads', () => {
  it('lists every covered chain (aggregates aside) by transactions, with 7d change and attribution', async () => {
    serveAll();
    const list = await G.getL2Metrics();
    expect(list.attribution).toMatchObject({ source: 'growthepie', url: 'https://www.growthepie.com' });
    expect(list.dataSource).toBe('live');
    expect(list.chains.map(c => c.originKey)).toEqual(['base', 'starknet', 'ethereum']);
    const base = list.chains[0];
    // 1600 now vs 1530 seven days earlier.
    expect(base.metrics.txcount).toMatchObject({ value: 1600, date: '2026-10-16' });
    expect(base.metrics.txcount.change7d).toBeCloseTo(1600 / 1530 - 1, 10);
    // Days 54..60 average 1570; the week before (47..53) 1500.
    expect(base.metrics.txcount.avg7d).toBe(1570);
    expect(base.metrics.txcount.avg7dChange).toBeCloseTo(1570 / 1500 - 1, 10);
    expect(base).toMatchObject({ chainId: 8453, stack: 'OP Stack, Superchain', l2beatStage: 'Stage 1', txcostMedianUsd: 0.0018, users: 1434291 });
    expect(base.economics30d.profitUsd).toBe(2908164);
    // The all-L2 aggregate comes from the landing page series.
    expect(list.aggregate.metrics.txcount).toMatchObject({ value: 27795156.71, date: '2026-10-15' });
  });

  it('one chain in full by chain ID, history optional; Ethereum also carries ETH supply', async () => {
    serveAll();
    const base = await G.getL2MetricsForChain(8453);
    expect(base.metrics.txcount.series).toHaveLength(61);
    expect(base.metrics.daa.change30d).toBeCloseTo(560 / 530 - 1, 10);
    expect(base.fees.tps.value).toBe(156);
    expect(base.blockspace['30d'].social.txcount).toBe(3119172);
    expect(base.daLayersUsed).toEqual(['da_ethereum_blobs']);
    expect((await G.getL2MetricsForChain(8453, { series: false })).metrics.txcount).not.toHaveProperty('series');
    expect((await G.getL2MetricsForChain(1)).ethSupply.supply.value).toBe(122132893.75);
    expect(await G.getL2MetricsForChain(424242)).toBeNull();
  });

  it('the chain-detail block is compact, attributed, and never fetches', async () => {
    serveAll();
    await G.refreshGrowthepie({ force: true });
    getFeed.mockClear();
    const block = G.getL2MetricsBlock(8453);
    expect(block).toMatchObject({ chainId: 8453, name: 'Base', attribution: { source: 'growthepie' } });
    expect(block.metrics.txcount.value).toBe(1600);
    expect(block).not.toHaveProperty('fees');
    expect(G.getL2MetricsBlock(424242)).toBeNull();
    expect(getFeed).not.toHaveBeenCalled();
  });

  it('DA layers and ETH supply reads', async () => {
    serveAll();
    expect(Object.keys((await G.getDaLayers()).layers)).toEqual(['da_ethereum_blobs']);
    expect((await G.getEthSupply()).issuanceRate.value).toBe(0.0072);
  });
});

describe('refresh', () => {
  it('a failed or drifted file keeps the previous copy, records the error, and the answer says partial', async () => {
    serveAll();
    await G.refreshGrowthepie({ force: true });
    serveAll({ 'fees/table.json': { ok: false, status: 403, json: async () => ({}) }, 'economics.json': ok({ data: { changed: true } }) });
    await G.refreshGrowthepie({ force: true });
    const status = G.getGrowthepieStatus();
    expect(status.files.fees).toMatchObject({ source: 'live', error: 'HTTP 403' });
    expect(status.files.economics.error).toMatch(/no usable data/);
    // The previous fees are still served.
    expect((await G.getL2MetricsForChain(8453)).fees.txcosts_median.usd).toBe(0.0018);
  });

  it('a file never read live is partial; nothing read at all is unavailable', async () => {
    serveAll({ 'da_overview.json': { ok: false, status: 500, json: async () => ({}) } });
    await G.refreshGrowthepie({ force: true });
    expect((await G.getL2Metrics()).dataSource).toBe('partial');
    G._setGrowthepieForTests({});
    getFeed.mockRejectedValue(new Error('ECONNREFUSED'));
    expect((await G.getL2Metrics()).dataSource).toBe('unavailable');
  });

  it('serves the fallback snapshot until a live read, labelled as such', async () => {
    G._setGrowthepieForTests({ master: G.normalizeMaster(MASTER), fundamentals: G.normalizeFundamentals(FUNDAMENTALS) }, { source: 'fallback', fetchedAt: Date.parse('2026-10-01T00:00:00Z') });
    getFeed.mockRejectedValue(new Error('gated'));
    const list = await G.getL2Metrics();
    expect(list.dataSource).toBe('fallback');
    expect(list.fetchedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(list.chains[0].metrics.txcount.value).toBe(1600);
  });

  it('only re-reads files past their own max age', async () => {
    serveAll();
    await G.refreshGrowthepie({ force: true });
    getFeed.mockClear();
    await G.refreshGrowthepie();
    expect(getFeed).not.toHaveBeenCalled();
  });
});
