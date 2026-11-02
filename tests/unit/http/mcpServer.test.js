import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  RATE_LIMIT_WINDOW_MS: 60000,
  MCP_RATE_LIMIT_MAX: 3,
  MCP_MAX_SESSIONS: 2,
  MCP_SESSION_IDLE_MS: 1000,
  RATE_LIMIT_CLIENT_IP_HEADER: 'cf-connecting-ip'
}));
vi.mock('../../../dataService.js', () => ({
  initializeDataOnStartup: vi.fn(), startRpcHealthCheck: vi.fn(),
  getCachedData: () => ({ indexed: null, lastUpdated: null })
}));

import { createMcpHttpApp } from '../../../mcp-server-http.js';

let server;
let app;
let clock = 1_000_000;
afterEach(async () => {
  app?.locals.stopSweeper();
  for (const t of Object.values(app?.locals.transports ?? {})) await t.close().catch(() => {});
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  server = null;
});

async function start() {
  app = createMcpHttpApp({ now: () => clock });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return `http://127.0.0.1:${server.address().port}/mcp`;
}

const init = (url, ip = '203.0.113.7') => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': ip },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
});

describe('MCP HTTP server limits', () => {
  it('limits requests per visitor, not per gateway', async () => {
    const url = await start();
    for (let i = 0; i < 2; i++) expect((await init(url, '203.0.113.7')).status).toBe(200);
    // The third from the same visitor is over MCP_MAX_SESSIONS (2) — but a fourth is over the
    // rate budget (3) whatever it asks.
    await init(url, '203.0.113.7');
    const limited = await init(url, '203.0.113.7');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    // Another visitor through the same gateway has its own budget.
    expect((await init(url, '198.51.100.9')).status).not.toBe(429);
  });

  it('caps open sessions, and frees idle ones before refusing', async () => {
    const url = await start();
    expect((await init(url, '192.0.2.1')).status).toBe(200);
    expect((await init(url, '192.0.2.2')).status).toBe(200);
    expect((await init(url, '192.0.2.3')).status).toBe(503);
    expect(Object.keys(app.locals.transports)).toHaveLength(2);
    // Past MCP_SESSION_IDLE_MS unused: the next initialize sweeps them and gets in.
    clock += 2000;
    expect((await init(url, '192.0.2.4')).status).toBe(200);
    expect(Object.keys(app.locals.transports)).toHaveLength(1);
  });

  it('closes sessions unused for the idle window on the periodic sweep', async () => {
    const url = await start();
    await init(url);
    expect(Object.keys(app.locals.transports)).toHaveLength(1);
    clock += 999;
    await app.locals.sweepIdleSessions();
    expect(Object.keys(app.locals.transports)).toHaveLength(1);
    clock += 2;
    await app.locals.sweepIdleSessions();
    expect(Object.keys(app.locals.transports)).toHaveLength(0);
  });
});
