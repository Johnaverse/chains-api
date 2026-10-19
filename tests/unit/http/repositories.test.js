import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../../index.js';
import { aliasesOf } from '../../../src/http/routes/repositories.js';

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
    // Without registry data loaded, every network still carries an (empty) alias list.
    expect(body.networks.every(n => Array.isArray(n.aliases))).toBe(true);
    // The registry's test-network words travel with it (empty until chain data has loaded).
    expect(Array.isArray(body.testNetworkWords)).toBe(true);
  });

  it('gives each network the other names the registry knows it by, for the feed\'s fork matching', () => {
    expect(aliasesOf({ 'theGraph-id': 'chapel', aliases: ['bnb-chapel', 'BNB-Testnet', 'bsc-testnet', 'evm-97', 'chapel', ' '] }))
      .toEqual(['chapel', 'bnb-chapel', 'bnb-testnet', 'bsc-testnet']);
    expect(aliasesOf({ name: 'No aliases' })).toEqual([]);
    expect(aliasesOf(null)).toEqual([]);
  });

  it('serves the curated registry corrections for the feed to apply', async () => {
    const body = (await app.inject({ method: 'GET', url: '/repositories' })).json();
    expect(body.overridesReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(Object.keys(body.overrides.repositories).length).toBeGreaterThan(900);
    // Base runs base/base, not op-geth (the review moved 8453/84532 off the upstream client).
    expect(body.overrides.repositories['github:ethereum-optimism/op-geth'].drop).toEqual(expect.arrayContaining([8453, 84532]));
    expect(Array.isArray(body.overrides.pending)).toBe(true);
  });

  it('serves the client lineage the feed builds its family matchers from', async () => {
    const body = (await app.inject({ method: 'GET', url: '/repositories' })).json();
    expect(body.lineageReviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const keys = body.lineage.families.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(['geth', 'op-geth', 'erigon', 'reth', 'optimism', 'zksync-era', 'lighthouse']));
    // A more specific line must come before the family it customizes, so it wins the match.
    expect(keys.indexOf('op-geth')).toBeLessThan(keys.indexOf('geth'));
    expect(keys.indexOf('cdk-erigon')).toBeLessThan(keys.indexOf('erigon'));
    for (const f of body.lineage.families) {
      expect(f.repo).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      if (f.parent) expect(keys).toContain(f.parent);
      for (const former of f.formerRepos ?? []) expect(former).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      for (const word of [...(f.repoWords ?? []), ...(f.nameWords ?? [])]) expect(word).toMatch(/^[a-z0-9][a-z0-9 .-]*$/);
      expect((f.repoWords?.length ?? 0) + (f.nameWords?.length ?? 0)).toBeGreaterThan(0);
    }
    for (const [id, link] of Object.entries(body.lineage.links)) {
      expect(id).toMatch(/^(github|gitlab):[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
      expect(link.upstream).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    }
  });

  it('rejects a filter it does not support instead of returning everything', async () => {
    const res = await app.inject({ method: 'GET', url: '/repositories?chainId=1' });
    expect(res.statusCode).toBe(400);
  });
});
