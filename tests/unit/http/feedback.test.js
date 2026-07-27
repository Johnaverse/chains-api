import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../../index.js';
import { addFeedback, listFeedback, _resetFeedbackForTests } from '../../../src/services/feedback.js';

// The /feedback routes touch only the in-memory feedback store (persistence
// is disabled by the test reset), so the app builds without loading data.
// NOTE: POST /feedback shares one tight rate-limit bucket per app instance
// (FEEDBACK_RATE_LIMIT_MAX, default 5/window) and validation failures count
// too — keep the number of injected POSTs in this file at or under that.
let app;
beforeAll(async () => {
  app = await buildApp({ logger: false, loadDataOnStartup: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  _resetFeedbackForTests();
});

describe('POST /feedback', () => {
  it('records a report and answers 201 {received, id}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: {
        kind: 'upgrade',
        refId: 'sol-mainnet-v3.1.9',
        reason: 'not_related',
        comment: 'The RPC outage started before the activation window.',
        page: 'timeline'
      }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.received).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);

    // The record is retrievable, carries the server identity, and no
    // network identity (privacy: never store IP / user-agent).
    const { feedback } = await listFeedback();
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ id: body.id, kind: 'upgrade', reason: 'not_related' });
    expect(feedback[0].receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(feedback[0])).not.toMatch(/user-agent|remoteAddress/i);
  });

  it('rejects unknown fields (additionalProperties)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { kind: 'incident', reason: 'outdated', ip: '203.0.113.7' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('ip');
    expect((await listFeedback()).totalMatched).toBe(0);
  });

  it('rejects a comment over 500 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { kind: 'news', reason: 'other', comment: 'x'.repeat(501) }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/comment/i);
  });

  it('requires kind and reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/feedback',
      payload: { comment: 'missing the required fields' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('error');
  });
});

// GET tests seed through the store directly — going through POST would burn
// the tight per-route rate limit long before 1000 records.
describe('GET /feedback', () => {
  async function seed(n, kind = 'upgrade') {
    for (let i = 0; i < n; i++) {
      await addFeedback({ kind, reason: 'other', refId: `${kind}-${i}` });
    }
  }

  it('returns the contract envelope, newest-first', async () => {
    await seed(3, 'upgrade');
    await seed(2, 'incident');
    const res = await app.inject({ method: 'GET', url: '/feedback' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalMatched).toBe(5);
    expect(body.count).toBe(5);
    expect(body.truncated).toBe(false);
    // Newest-first: the last record added comes back first.
    expect(body.feedback[0].refId).toBe('incident-1');
    expect(body.feedback[4].refId).toBe('upgrade-0');
  });

  it('filters by kind', async () => {
    await seed(3, 'upgrade');
    await seed(2, 'incident');
    const res = await app.inject({ method: 'GET', url: '/feedback?kind=incident' });
    const body = res.json();
    expect(body.totalMatched).toBe(2);
    expect(body.feedback.every((r) => r.kind === 'incident')).toBe(true);
  });

  it('rejects an unknown kind and unknown query parameters', async () => {
    expect((await app.inject({ method: 'GET', url: '/feedback?kind=bogus' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/feedback?nope=1' })).statusCode).toBe(400);
  });

  it('applies the limit (default 50, max 500) and flags truncation', async () => {
    await seed(60);
    const def = (await app.inject({ method: 'GET', url: '/feedback' })).json();
    expect(def.count).toBe(50);
    expect(def.totalMatched).toBe(60);
    expect(def.truncated).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/feedback?limit=501' })).statusCode).toBe(400);
  });

  it('evicts oldest at the 1000-record cap (newest kept)', async () => {
    await seed(1005);
    const res = await app.inject({ method: 'GET', url: '/feedback?limit=500' });
    const body = res.json();
    expect(body.totalMatched).toBe(1000);      // ring capped, not 1005
    expect(body.count).toBe(500);
    expect(body.truncated).toBe(true);
    // Newest kept, oldest evicted: with 1000 remaining of 1005 and the head
    // still the last insert, the 5 dropped can only be upgrade-0…4.
    expect(body.feedback[0].refId).toBe('upgrade-1004');
    expect(body.feedback[499].refId).toBe('upgrade-505');
  });
});
