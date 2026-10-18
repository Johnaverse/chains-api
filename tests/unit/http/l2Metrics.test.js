import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { getFeed } from '../../../src/sources/feedHttp.js';
import { BODIES } from '../../fixtures/growthepie.js';

vi.mock('../../../src/sources/feedHttp.js', () => ({ getFeed: vi.fn() }));

const { buildApp } = await import('../../../index.js');
const G = await import('../../../src/sources/growthepie.js');

let app;
beforeAll(async () => { app = await buildApp({ logger: false, loadDataOnStartup: false }); });
afterAll(async () => { await app.close(); });
beforeEach(() => {
  G._setGrowthepieForTests({});
  getFeed.mockReset();
  getFeed.mockImplementation(async url => ({ ok: true, status: 200, json: async () => BODIES[url.replace(/^https?:\/\/[^/]+\/v1\//, '')] }));
});

const get = url => app.inject({ method: 'GET', url });

describe('/l2-metrics', () => {
  it('lists the covered chains with attribution and metric labels', async () => {
    const res = await get('/l2-metrics');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.attribution.source).toBe('growthepie');
    expect(body.count).toBe(3);
    expect(body.chains[0]).toMatchObject({ chainId: 8453, name: 'Base' });
    expect(body.metricsInfo.daa.name).toBe('Active Addresses');
  });

  it('serves one chain in full, history optional; 404 for an uncovered chain; 400 for a bad id', async () => {
    const full = (await get('/l2-metrics/8453')).json();
    expect(full.metrics.txcount.series).toHaveLength(61);
    expect(full.economics['30d'].profitUsd).toBe(2908164);
    const slim = (await get('/l2-metrics/8453?series=false')).json();
    expect(slim.metrics.txcount).not.toHaveProperty('series');
    expect((await get('/l2-metrics/424242')).statusCode).toBe(404);
    expect((await get('/l2-metrics/abc')).statusCode).toBe(400);
    expect((await get('/l2-metrics/8453?bogus=1')).statusCode).toBe(400);
  });

  it('serves DA layers, ETH supply and per-file status', async () => {
    expect(Object.keys((await get('/l2-metrics/da')).json().layers)).toEqual(['da_ethereum_blobs']);
    expect((await get('/l2-metrics/eth-supply')).json().supply.value).toBe(122132893.75);
    await get('/l2-metrics');
    const status = (await get('/l2-metrics/status')).json();
    expect(status.attribution.source).toBe('growthepie');
    expect(status.files.fundamentals).toMatchObject({ path: 'fundamentals.json', source: 'live', error: null });
  });
});
