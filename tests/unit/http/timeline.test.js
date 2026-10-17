import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { buildApp } from '../../../index.js';
import { getTimeline } from '../../../src/services/timeline.js';

vi.mock('../../../src/services/timeline.js', async (importOriginal) => ({ ...(await importOriginal()), getTimeline: vi.fn() }));

let app;
beforeAll(async () => {
  app = await buildApp({ logger: false, loadDataOnStartup: false });
});
afterAll(async () => {
  await app.close();
});

describe('GET /timeline', () => {
  beforeEach(() => {
    getTimeline.mockReset();
    getTimeline.mockResolvedValue({ totalMatched: 0, count: 0, truncated: false, entries: [] });
  });

  it('passes a chain\'s hardfork-history query through', async () => {
    const res = await app.inject({ method: 'GET', url: '/timeline?chainId=1&type=hardfork&limit=50' });
    expect(res.statusCode).toBe(200);
    expect(getTimeline).toHaveBeenCalledWith({ chainId: 1, type: 'hardfork', limit: 50 });
  });

  it('accepts a comma list of types', async () => {
    const res = await app.inject({ method: 'GET', url: '/timeline?type=hardfork,software_update' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unknown type and an unknown parameter', async () => {
    expect((await app.inject({ method: 'GET', url: '/timeline?type=incident' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/timeline?network=base' })).statusCode).toBe(400);
  });

  it('answers 503 when the sources are down', async () => {
    getTimeline.mockRejectedValue(new Error('Timeline sources unavailable'));
    const res = await app.inject({ method: 'GET', url: '/timeline' });
    expect(res.statusCode).toBe(503);
  });
});
