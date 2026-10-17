import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFeed } from '../../src/sources/feedHttp.js';
import { BODIES } from '../fixtures/growthepie.js';

vi.mock('../../src/sources/feedHttp.js', () => ({ getFeed: vi.fn() }));

const { handleToolCall } = await import('../../mcp-tools.js');
const G = await import('../../src/sources/growthepie.js');
const call = async args => JSON.parse((await handleToolCall('get_l2_metrics', args)).content[0].text);

beforeEach(() => {
  G._setGrowthepieForTests({});
  getFeed.mockReset();
  getFeed.mockImplementation(async url => ({ ok: true, status: 200, json: async () => BODIES[url.replace(/^https?:\/\/[^/]+\/v1\//, '')] }));
});

describe('get_l2_metrics', () => {
  it('ranks chains by a metric with honest counts, the all-L2 total and attribution', async () => {
    const out = await call({ metric: 'txcount', limit: 2 });
    expect(out.attribution.source).toBe('growthepie');
    expect(out).toMatchObject({ metric: 'txcount', totalMatched: 2, count: 2, truncated: false });
    expect(out.chains.map(c => c.name)).toEqual(['Base', 'Starknet']);
    expect(out.allL2s.value).toBe(27795156.71);
  });

  it('ranks by any metric; one nobody reports gives an empty, honest list', async () => {
    const daa = await call({ metric: 'daa' });
    expect(daa.chains.map(c => [c.name, c.value])).toEqual([['Ethereum Mainnet', 400000], ['Base', 560]]);
    expect(await call({ metric: 'no_such_metric' })).toMatchObject({ totalMatched: 0, count: 0, chains: [] });
  });

  it('one chain: profile, metrics with changes, fees, economics, blockspace shares; history on request', async () => {
    const out = await call({ chainId: 8453, metric: 'daa', days: 7 });
    expect(out.profile).toMatchObject({ stack: 'OP Stack, Superchain', l2beatStage: 'Stage 1', daLayer: 'Ethereum (blobs)' });
    expect(out.metrics.txcount.value).toBe(1600);
    expect(out.history).toMatchObject({ metric: 'daa', days: 7 });
    expect(out.history.points.at(-1)).toEqual(['2026-10-16', 560]);
    expect(out.economics['30d'].profitMargin).toBeCloseTo(0.9936, 4);
    expect(out.blockspace30d.finance.txcountShare).toBe(0.35);
  });

  it('says plainly when a chain is not covered', async () => {
    expect(await call({ chainId: 424242 })).toMatchObject({ covered: false });
  });

  it('DA and ETH supply views', async () => {
    const da = await call({ view: 'da' });
    expect(da.layers.da_ethereum_blobs).toMatchObject({ period: '30d', consumerCount: 42, consumers: ['Base', 'Blast'] });
    expect((await call({ view: 'eth_supply' })).supply.value).toBe(122132893.75);
  });

  it('requires a chainId for the chain view', async () => {
    const res = await handleToolCall('get_l2_metrics', { view: 'chain' });
    expect(res.isError).toBe(true);
  });
});
