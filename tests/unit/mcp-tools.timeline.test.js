import { describe, it, expect, vi, beforeEach } from 'vitest';

const svc = vi.hoisted(() => ({ getTimeline: vi.fn() }));
vi.mock('../../src/services/timeline.js', () => svc);

const { handleToolCall } = await import('../../mcp-tools.js');
const parse = (r) => JSON.parse(r.content[0].text);

const entry = (n) => ({
  id: `fork:${n}`, type: 'hardfork', name: 'Fusaka', title: 'Fusaka', url: 'https://r/0', network: 'ethereum',
  networkNames: ['ethereum'], networkSlugs: ['ethereum'], chainIds: [1], activationAt: '2025-12-03T21:49:00.000Z',
  activationEvidence: 'stated', activationPrecision: 'time', activationBlock: null, phase: 'past', state: 'completed',
  urgency: 'mandatory', sources: ['github:sigp/lighthouse'], feeds: ['release'], provider: null, providers: [],
  counts: { releases: n, providerUpdates: 0, news: 0, followedByIncidents: 0 },
  releases: Array.from({ length: n }, (_, i) => ({ repo: `r${i}`, version: '1', mandatory: true, class: 'planned_hard_fork', title: 't', url: `https://r/${i}`, publishedAt: '2025-11-01T00:00:00Z' })),
  providerUpdates: [], news: [], followedByIncidents: []
});

describe('get_timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.getTimeline.mockResolvedValue({ totalMatched: 1, count: 1, truncated: false, byType: {}, byPhase: {}, sources: {}, entries: [entry(7)] });
  });

  it('defaults to a small page and passes the filters through', async () => {
    await handleToolCall('get_timeline', { chainId: 1, type: 'hardfork' });
    expect(svc.getTimeline).toHaveBeenCalledWith(expect.objectContaining({ chainId: 1, type: 'hardfork', limit: 5 }));
  });

  it('caps the page at 100', async () => {
    await handleToolCall('get_timeline', { limit: 1000 });
    expect(svc.getTimeline).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  it('samples each group, keeps its full count, and drops joining fields and nulls', async () => {
    const out = parse(await handleToolCall('get_timeline', {}));
    const [e] = out.entries;
    expect(e.releases).toHaveLength(2);
    expect(e.counts.releases).toBe(7);
    expect(e).not.toHaveProperty('networkSlugs');
    expect(e).not.toHaveProperty('id');
    expect(e).not.toHaveProperty('activationBlock');
    expect(e.releases[0]).toEqual({ repo: 'r0', version: '1', mandatory: true, url: 'https://r/0', publishedAt: '2025-11-01T00:00:00Z' });
  });

  it('reports an outage as a tool error', async () => {
    svc.getTimeline.mockRejectedValue(new Error('Timeline sources unavailable'));
    const r = await handleToolCall('get_timeline', {});
    expect(r.isError).toBe(true);
  });
});
