import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLiveIncidents, getLiveEvents, _resetLiveIncidentsCacheForTests } from '../../../src/sources/liveIncidents.js';
import { proxyFetch } from '../../../fetchUtil.js';

vi.mock('../../../fetchUtil.js', () => ({
  proxyFetch: vi.fn()
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  LIVE_INCIDENTS_URL: 'https://status-news.test',
  LIVE_INCIDENTS_CACHE_TTL_MS: 60000,
  LIVE_INCIDENTS_FETCH_TIMEOUT_MS: 1000
}));

function feedEvent(overrides = {}) {
  return {
    title: 'RPC degraded',
    url: 'https://status.example/incident/1',
    publishedAt: '2026-07-05T10:00:00Z',
    statusPage: { id: 'base', name: 'Base', kind: 'chain' },
    chains: [{ chainId: 8453, name: 'Base' }],
    affectedComponents: [],
    ...overrides
  };
}

function okResponse(events) {
  return { ok: true, json: async () => ({ events }) };
}

describe('getLiveIncidents', () => {
  beforeEach(() => {
    _resetLiveIncidentsCacheForTests();
    proxyFetch.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-06T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches, normalizes and returns incidents', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedEvent()]));
    const result = await getLiveIncidents();
    expect(proxyFetch).toHaveBeenCalledWith(
      'https://status-news.test/events?limit=500',
      expect.objectContaining({ headers: { accept: 'application/json' } })
    );
    expect(result.count).toBe(1);
    expect(result.incidents[0]).toMatchObject({
      title: 'RPC degraded',
      isProvider: false,
      publishedAt: '2026-07-05T10:00:00.000Z',
      statusPage: { id: 'base', kind: 'chain' },
      chains: [{ chainId: 8453, name: 'Base' }]
    });
  });

  it('passes through the structured incident state (status/ongoing/impact)', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedEvent({ status: 'investigating', ongoing: true, impact: 'major' })
    ]));
    const result = await getLiveIncidents();
    expect(result.incidents[0]).toMatchObject({ status: 'investigating', ongoing: true, impact: 'major' });
  });

  it('defaults state fields to null when the feed omits them', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedEvent()]));
    const result = await getLiveIncidents();
    expect(result.incidents[0]).toMatchObject({ status: null, ongoing: null, impact: null });
  });

  it('filters by ongoing state', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedEvent({ title: 'Active', ongoing: true }),
      feedEvent({ title: 'Resolved', ongoing: false })
    ]));
    expect((await getLiveIncidents({ ongoing: true })).incidents.map((i) => i.title)).toEqual(['Active']);
    expect((await getLiveIncidents({ ongoing: false })).incidents.map((i) => i.title)).toEqual(['Resolved']);
    expect((await getLiveIncidents()).incidents).toHaveLength(2); // no filter → both
  });

  it('filters by lifecycle status', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedEvent({ title: 'Open incident', status: 'investigating' }),
      feedEvent({ title: 'Planned upgrade', status: 'maintenance_scheduled' }),
      feedEvent({ title: 'Old incident', status: 'resolved' }),
    ]));
    expect((await getLiveIncidents({ status: 'maintenance_scheduled' })).incidents.map((i) => i.title)).toEqual(['Planned upgrade']);
    expect((await getLiveIncidents({ status: 'investigating' })).incidents.map((i) => i.title)).toEqual(['Open incident']);
    expect((await getLiveIncidents({ status: 'major_outage' })).incidents).toHaveLength(0);
  });

  it('serves from cache within the TTL (single upstream fetch)', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedEvent()]));
    await getLiveIncidents();
    await getLiveIncidents();
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedEvent()]));
    await getLiveIncidents();
    vi.advanceTimersByTime(61000);
    await getLiveIncidents();
    expect(proxyFetch).toHaveBeenCalledTimes(2);
  });

  it('dedupes events by status page + title, keeping the newest', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedEvent({ publishedAt: '2026-07-05T10:00:00Z', url: 'https://old' }),
      feedEvent({ publishedAt: '2026-07-05T12:00:00Z', url: 'https://new' }),
      feedEvent({ title: 'Other incident' })
    ]));
    const result = await getLiveIncidents();
    expect(result.count).toBe(2);
    const rpc = result.incidents.find((it) => it.title === 'RPC degraded');
    expect(rpc.url).toBe('https://new');
  });

  it('filters by type, chainId and provider', async () => {
    proxyFetch.mockResolvedValue(okResponse([
      feedEvent(),
      feedEvent({
        title: 'Provider outage',
        statusPage: { id: 'infura', name: 'Infura', kind: 'rpc-provider' },
        chains: [{ chainId: 1, name: 'Ethereum' }]
      })
    ]));
    expect((await getLiveIncidents({ type: 'chain' })).incidents).toHaveLength(1);
    expect((await getLiveIncidents({ type: 'provider' })).incidents[0].title).toBe('Provider outage');
    expect((await getLiveIncidents({ chainId: 1 })).incidents[0].statusPage.id).toBe('infura');
    expect((await getLiveIncidents({ provider: 'INFURA' })).incidents).toHaveLength(1);
    expect((await getLiveIncidents({ provider: 'quicknode' })).incidents).toHaveLength(0);
  });

  it('caps limit and reports totalMatched', async () => {
    const events = Array.from({ length: 40 }, (_, i) => feedEvent({ title: `Incident ${i}` }));
    proxyFetch.mockResolvedValue(okResponse(events));
    const result = await getLiveIncidents({ limit: 5 });
    expect(result.count).toBe(5);
    expect(result.totalMatched).toBe(40);
    const capped = await getLiveIncidents({ limit: 9999 });
    expect(capped.count).toBe(40); // fewer than the 100 cap available
  });

  it('serves stale cache when a refresh fails', async () => {
    proxyFetch.mockResolvedValueOnce(okResponse([feedEvent()]));
    await getLiveIncidents();
    vi.advanceTimersByTime(61000);
    proxyFetch.mockRejectedValueOnce(new Error('boom'));
    const result = await getLiveIncidents();
    expect(result.count).toBe(1);
  });

  it('throws when the feed is unreachable and no cache exists', async () => {
    proxyFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getLiveIncidents()).rejects.toThrow(/Live incident feed unavailable/);
  });

  it('throws on non-2xx responses with no cache', async () => {
    proxyFetch.mockResolvedValue({ ok: false, status: 502 });
    await expect(getLiveIncidents()).rejects.toThrow(/502/);
  });
});

describe('enrichment passthrough (the fork join key)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetLiveIncidentsCacheForTests();
  });

  it('carries fork identity and affectedChains through to consumers', async () => {
    // This is where the fork pipeline silently broke once already: the feed served the field,
    // the normalizer dropped it, and every consumer joined on data that was never there.
    proxyFetch.mockResolvedValue(okResponse([feedEvent({
      enrichment: {
        class: 'planned_software_update',
        summary: 'a long prose summary that costs tokens',
        context: { whatChanged: 'x', actionRequired: 'y', references: [] },
        affectedChains: ['Stellar Mainnet'],
        fork: { name: 'Protocol 28', activationAt: '2026-09-16T17:00:00Z', activationBlock: null, state: 'scheduled' }
      }
    })]));

    const [event] = await getLiveEvents();

    expect(event.enrichment.fork).toEqual({
      name: 'Protocol 28', activationAt: '2026-09-16T17:00:00Z', activationBlock: null, state: 'scheduled'
    });
    expect(event.enrichment.affectedChains).toEqual(['Stellar Mainnet']);
    expect(event.enrichment.class).toBe('planned_software_update');
  });

  it('drops the prose fields, which is the whole reason this is partial', async () => {
    // The normalizer parses and discards the entry body for exactly this reason; carrying
    // summary/context would put it straight back into the assistant's context window.
    proxyFetch.mockResolvedValue(okResponse([feedEvent({
      enrichment: {
        class: 'provider_incident',
        summary: 'prose',
        context: { whatChanged: 'x', actionRequired: 'y', references: [] }
      }
    })]));

    const [event] = await getLiveEvents();

    expect(event.enrichment.summary).toBeUndefined();
    expect(event.enrichment.context).toBeUndefined();
    expect(event.enrichment.class).toBe('provider_incident');
  });

  it('omits enrichment entirely when the event has none, so its presence means something', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedEvent()]));
    const [event] = await getLiveEvents();
    expect(event.enrichment).toBeUndefined();
  });

  it('rejects a malformed fork rather than passing junk to the grouping', async () => {
    proxyFetch.mockResolvedValue(okResponse([feedEvent({
      enrichment: { fork: { name: 42, activationAt: {}, activationBlock: '18,813,000', state: ['x'] } }
    })]));

    const [event] = await getLiveEvents();

    expect(event.enrichment.fork).toEqual({ name: null, activationAt: null, activationBlock: null, state: null });
  });
});
