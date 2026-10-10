import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { applyDataToCache } from '../../../src/store/cache.js';
import { summaryRoute, _resetSummaryCacheForTests } from '../../../src/http/routes/summary.js';

function seed(overrides = {}) {
  applyDataToCache({
    indexed: {
      byChainId: {},
      byName: {},
      all: [
        {
          chainId: 1,
          family: 'Ethereum',
          name: 'Ethereum Mainnet',
          shortName: 'eth',
          tags: ['Beacon'],
          rpc: [
            'https://rpc.example/eth',
            'https://mainnet.infura.io/v3/${INFURA_API_KEY}', // templated → excluded
            'wss://rpc.example/ws',                            // non-http → excluded
            { url: 'https://rpc2.example/eth' }
          ],
          relations: [
            { kind: 'parentOf', network: 'OP Mainnet', chainId: 10, source: 'theGraph' },
            { kind: 'mainnetOf', network: 'Sepolia' } // no chainId → dropped
          ],
          explorers: [{ url: 'https://etherscan.io' }], // heavy field → not in slim
          theGraph: { id: 'mainnet' }
        },
        { chainId: 999, name: 'Bare Chain' }
      ]
    },
    l2beat: {
      source: 'live',
      fetchedAt: '2026-06-01T00:00:00.000Z',
      projects: [
        {
          slug: 'optimism', displayName: 'OP Mainnet', chainId: 10, category: 'Rollup',
          stage: 'Stage 1', stack: 'OP Stack', daLayer: 'Ethereum', hostChainId: 1,
          tvs: 123456, riskView: { big: 'object-not-needed' }, milestones: [{}]
        }
      ]
    },
    lastUpdated: '2026-06-01T00:00:00.000Z',
    ...overrides
  });
}

describe('GET /summary', () => {
  let app;

  beforeEach(async () => {
    _resetSummaryCacheForTests();
    seed();
    app = Fastify({ logger: false });
    await app.register(summaryRoute);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns the slim projection with counts, tags, relations, rpcCount', async () => {
    const res = await app.inject({ method: 'GET', url: '/summary' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.lastUpdated).toBe('2026-06-01T00:00:00.000Z');

    const eth = body.chains.find(c => c.chainId === 1);
    expect(eth).toMatchObject({ name: 'Ethereum Mainnet', shortName: 'eth', tags: ['Beacon'] });
    // Only browser-usable endpoints count: templated + wss excluded.
    expect(eth.rpcCount).toBe(2);
    // Relations are slimmed to kind+chainId; entries without a chainId drop.
    expect(eth.relations).toEqual([{ kind: 'parentOf', chainId: 10 }]);
    expect(eth.family).toBe('Ethereum');
    // Heavy fields are not shipped.
    expect(eth.explorers).toBeUndefined();
    expect(eth.theGraph).toBeUndefined();
  });

  it('ships registry aliases for renamed chains, minus machine ids and name duplicates', async () => {
    seed({
      indexed: {
        byChainId: {},
        byName: {},
        all: [{
          chainId: 10,
          name: 'OP Mainnet',
          shortName: 'oeth',
          theGraph: {
            id: 'optimism',
            shortName: 'Optimism',
            aliases: ['evm-10', 'op-mainnet', 'optimism-mainnet']
          }
        }]
      },
      lastUpdated: '2026-06-02T00:00:00.000Z'
    });
    _resetSummaryCacheForTests();
    const res = await app.inject({ method: 'GET', url: '/summary' });
    const op = res.json().chains.find(c => c.chainId === 10);
    expect(op.aliases).toContain('optimism');            // graph id
    expect(op.aliases).toContain('optimism mainnet');    // hyphen → space variant
    expect(op.aliases).toContain('op-mainnet');
    expect(op.aliases.some(a => a.startsWith('evm'))).toBe(false); // machine ids dropped
    expect(op.aliases).not.toContain('op mainnet');      // = the chain's own name, already matched
  });

  it('ships non-default statuses and omits the implied active', async () => {
    seed({
      indexed: {
        byChainId: {},
        byName: {},
        all: [
          { chainId: 5, name: 'Goerli', status: 'deprecated' },
          { chainId: 1, name: 'Ethereum Mainnet', status: 'active' }
        ]
      },
      lastUpdated: '2026-06-03T00:00:00.000Z'
    });
    _resetSummaryCacheForTests();
    const res = await app.inject({ method: 'GET', url: '/summary' });
    const chains = res.json().chains;
    expect(chains.find(c => c.chainId === 5).status).toBe('deprecated');
    expect(chains.find(c => c.chainId === 1).status).toBeUndefined(); // active is implied
  });

  it('omits empty optional fields and defaults rpcCount to 0', async () => {
    const res = await app.inject({ method: 'GET', url: '/summary' });
    const bare = res.json().chains.find(c => c.chainId === 999);
    expect(bare).toEqual({ chainId: 999, name: 'Bare Chain', rpcCount: 0 });
  });

  it('slims l2beat projects to headline fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/summary' });
    const { l2beat } = res.json();
    expect(l2beat.source).toBe('live');
    expect(l2beat.projects).toEqual([{
      slug: 'optimism', displayName: 'OP Mainnet', chainId: 10, category: 'Rollup',
      stage: 'Stage 1', stack: 'OP Stack', daLayer: 'Ethereum', hostChainId: 1, tvs: 123456
    }]);
  });

  it('serves an ETag and answers a matching If-None-Match with 304', async () => {
    const first = await app.inject({ method: 'GET', url: '/summary' });
    const etag = first.headers.etag;
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers['cache-control']).toContain('max-age=60');

    const second = await app.inject({
      method: 'GET', url: '/summary', headers: { 'if-none-match': etag }
    });
    expect(second.statusCode).toBe(304);
    expect(second.payload).toBe('');
  });

  it('busts the cached body (and ETag) when the data version changes', async () => {
    const first = await app.inject({ method: 'GET', url: '/summary' });

    seed({ lastUpdated: '2026-06-02T00:00:00.000Z' });
    const second = await app.inject({ method: 'GET', url: '/summary' });

    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.json().lastUpdated).toBe('2026-06-02T00:00:00.000Z');

    // Stale ETag no longer revalidates.
    const third = await app.inject({
      method: 'GET', url: '/summary', headers: { 'if-none-match': first.headers.etag }
    });
    expect(third.statusCode).toBe(200);
  });

  it('handles an empty store gracefully', async () => {
    applyDataToCache({});
    _resetSummaryCacheForTests();
    const res = await app.inject({ method: 'GET', url: '/summary' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 0, chains: [], l2beat: null });
  });
});
