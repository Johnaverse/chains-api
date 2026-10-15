import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../../index.js';

// Static research data only, so the app is built without loading chain data.
let app;
beforeAll(async () => {
  app = await buildApp({ logger: false, loadDataOnStartup: false });
});
afterAll(async () => {
  await app.close();
});

describe('GET /repositories', () => {
  it('serves the per-chain repository inputs from the checked-in research', async () => {
    const res = await app.inject({ method: 'GET', url: '/repositories' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(body.networks.length);
    expect(body.count).toBeGreaterThan(1000);
    const eth = body.networks.find(n => n.chainId === 1);
    expect(eth.repositories.some(r => r.repo === 'ethereum/go-ethereum')).toBe(true);
    expect(eth.hardware).toHaveProperty('profiles');
  });

  it('serves the curated registry corrections for the feed to apply', async () => {
    const body = (await app.inject({ method: 'GET', url: '/repositories' })).json();
    expect(body.overridesReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(Object.keys(body.overrides.repositories).length).toBeGreaterThan(900);
    // Base runs base/base, not op-geth (the review moved 8453/84532 off the upstream client).
    expect(body.overrides.repositories['github:ethereum-optimism/op-geth'].drop).toEqual(expect.arrayContaining([8453, 84532]));
    expect(Array.isArray(body.overrides.pending)).toBe(true);
  });

  it('rejects a filter it does not support instead of returning everything', async () => {
    const res = await app.inject({ method: 'GET', url: '/repositories?chainId=1' });
    expect(res.statusCode).toBe(400);
  });
});
