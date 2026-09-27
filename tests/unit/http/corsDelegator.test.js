import { describe, it, expect, vi } from 'vitest';

// app.js pulls in the whole service graph at import; only the delegator is under test here.
vi.mock('../../../src/services/loader.js', () => ({ initializeDataOnStartup: vi.fn() }));

import { corsDelegator } from '../../../src/http/app.js';

const DASHBOARD = 'https://www.x.io';
const on = { enabled: true, origins: new Set([DASHBOARD]) };
const off = { enabled: false, origins: new Set() };

function decide(auth, { url = '/chains', origin } = {}, corsOrigin = '*') {
  let out;
  corsDelegator(corsOrigin, () => auth)({ url, headers: origin ? { origin } : {} }, (err, opts) => { out = opts; });
  return out;
}

describe('corsDelegator', () => {
  it('leaves the API policy untouched when accounts are off', () => {
    expect(decide(off, { origin: 'https://anyone.io' })).toEqual({ origin: true, credentials: false });
    expect(decide(off, { origin: 'https://a.io' }, 'https://a.io, https://b.io')).toEqual({
      origin: ['https://a.io', 'https://b.io'], credentials: false
    });
  });

  it('gives the dashboard origin credentialed CORS, echoing it exactly — never reflecting', () => {
    expect(decide(on, { url: '/auth/session', origin: DASHBOARD })).toEqual({ origin: DASHBOARD, credentials: true });
    expect(decide(on, { url: '/feedback', origin: DASHBOARD })).toEqual({ origin: DASHBOARD, credentials: true });
  });

  it('never grants credentials to any other origin, even with CORS_ORIGIN=*', () => {
    const d = decide(on, { url: '/chains', origin: 'https://evil.test' });
    expect(d.credentials).toBe(false);
  });

  it('denies /auth/* to foreign origins outright, so they cannot read the answer', () => {
    expect(decide(on, { url: '/auth/session', origin: 'https://evil.test' })).toEqual({ origin: false });
    expect(decide(on, { url: '/auth/login/start?x=1', origin: 'https://evil.test' })).toEqual({ origin: false });
  });

  it('keeps the normal policy for non-auth routes and origin-less requests', () => {
    expect(decide(on, { url: '/chains', origin: 'https://other.io' })).toEqual({ origin: true, credentials: false });
    expect(decide(on, { url: '/auth/session' })).toEqual({ origin: false });
  });
});
