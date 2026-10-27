import { applyDataToCache } from '../../../src/store/cache.js';
import { getRpcMonitoringResults } from '../../../src/store/queries.js';

describe('getRpcMonitoringResults', () => {
  it('counts an endpoint a provider is throttling us on as neither working nor failed', () => {
    applyDataToCache({
      indexed: { byChainId: { 1: { chainId: 1, name: 'Ethereum' } }, byName: {}, all: [] },
      rpcHealth: {
        1: [
          { url: 'https://a.example', ok: true, blockHeight: 1 },
          { url: 'https://b.example', ok: false, failure: 'unreachable', error: 'fetch failed' },
          { url: 'https://c.example', ok: false, failure: 'rate_limited', error: 'HTTP 429' }
        ]
      },
      lastUpdated: '2026-10-27T00:00:00.000Z'
    });
    const out = getRpcMonitoringResults();
    expect(out).toMatchObject({ totalEndpoints: 3, workingEndpoints: 1, failedEndpoints: 1, rateLimitedEndpoints: 1 });
    expect(out.results.map(r => r.status)).toEqual(['working', 'failed', 'rate_limited']);
  });
});
