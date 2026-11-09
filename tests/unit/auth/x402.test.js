import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  RATE_LIMIT_WINDOW_MS: 60000,
  MCP_RATE_LIMIT_MAX: 50,
  MCP_MAX_SESSIONS: 50,
  MCP_SESSION_IDLE_MS: 600000
}));
vi.mock('../../../dataService.js', () => ({
  initializeDataOnStartup: vi.fn(), startRpcHealthCheck: vi.fn(),
  getCachedData: () => ({ indexed: null, lastUpdated: null })
}));
const runTool = vi.fn();
vi.mock('../../../mcp-tools.js', () => ({
  getToolDefinitions: () => [{ name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: {} } }],
  handleToolCall: (name, args) => (name === 'echo' ? runTool(args) : { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] })
}));

import { x402Paywall, paymentToken } from '../../../src/auth/x402.js';
import { memoryStore } from '../../../src/auth/store.js';
import { createLicenceKey } from '../../../src/auth/licenceKeys.js';
import { createMcpHttpApp } from '../../../mcp-server-http.js';
import { renderMetrics, _resetMetricsForTests } from '../../../src/util/metrics.js';

const ACCEPT = { scheme: 'exact', network: 'eip155:84532', amount: '1000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
const PAYMENT = { x402Version: 2, accepted: ACCEPT, payload: { signature: '0xsig', authorization: { from: '0xpayer', value: '1000' } } };
const CFG = { payTo: ACCEPT.payTo, network: ACCEPT.network, priceUsd: 0.001, facilitatorUrl: 'https://facilitator.test' };
const TOOL = { name: 'echo', description: 'Echo the input' };

/** A stand-in for @x402/core's x402ResourceServer, backed by a facilitator that accepts PAYMENT. */
function fakeServer({ valid = true, settles = true, initFails = 0 } = {}) {
  let failures = initFails;
  return {
    initialize: vi.fn(async () => { if (failures-- > 0) throw new Error('facilitator down'); }),
    buildPaymentRequirements: vi.fn(async () => [ACCEPT]),
    findMatchingRequirements: vi.fn((accepts, p) => accepts.find(a => a.payTo === p?.accepted?.payTo && a.amount === p?.accepted?.amount)),
    verifyPayment: vi.fn(async () => (valid ? { isValid: true, payer: '0xpayer' } : { isValid: false, invalidReason: 'insufficient_funds', payer: '0xpayer' })),
    settlePayment: vi.fn(async () => (settles ? { success: true, transaction: '0xtx', network: ACCEPT.network, payer: '0xpayer' } : { success: false, errorReason: 'nonce_used' }))
  };
}
const base64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const ok = { content: [{ type: 'text', text: 'hello' }] };

beforeEach(() => {
  _resetMetricsForTests();
  runTool.mockReset().mockResolvedValue(ok);
});

describe('x402Paywall', () => {
  it('answers an unpaid call with PaymentRequired in all three places', async () => {
    const s = fakeServer();
    const run = vi.fn();
    const res = await x402Paywall({ ...CFG, alternative: 'Or use a licence key', resourceServer: s }).call(TOOL, undefined, run);
    expect(run).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toEqual({
      x402Version: 2,
      error: 'Payment required. Or use a licence key',
      resource: { url: 'mcp://tool/echo', description: 'Echo the input', mimeType: 'application/json' },
      accepts: [ACCEPT]
    });
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    expect(res._meta['x402/error']).toEqual(res.structuredContent);
    expect(s.buildPaymentRequirements).toHaveBeenCalledWith({ scheme: 'exact', payTo: CFG.payTo, price: 0.001, network: CFG.network, maxTimeoutSeconds: 300 });
    expect(renderMetrics({ cache: {} })).toContain('chains_api_x402_payments_total{outcome="required"} 1');
  });

  it.each([['an object', PAYMENT], ['base64 JSON', base64(PAYMENT)]])('verifies, runs and settles a payment sent as %s', async (_label, token) => {
    const s = fakeServer();
    const res = await x402Paywall({ ...CFG, resourceServer: s }).call(TOOL, token, () => ok);
    expect(s.verifyPayment).toHaveBeenCalledWith(PAYMENT, ACCEPT);
    expect(s.settlePayment).toHaveBeenCalledWith(PAYMENT, ACCEPT);
    expect(res.content).toEqual(ok.content);
    expect(res._meta['x402/payment-response']).toEqual({ success: true, transaction: '0xtx', network: ACCEPT.network, payer: '0xpayer' });
    expect(renderMetrics({ cache: {} })).toContain('chains_api_x402_payments_total{outcome="settled"} 1');
  });

  it('rejects a payment that does not match, or that the facilitator refuses, without running the tool', async () => {
    const run = vi.fn();
    const wrong = await x402Paywall({ ...CFG, resourceServer: fakeServer() }).call(TOOL, { ...PAYMENT, accepted: { ...ACCEPT, amount: '1' } }, run);
    expect(wrong.structuredContent.error).toMatch(/^Invalid payment/);
    const garbage = await x402Paywall({ ...CFG, resourceServer: fakeServer() }).call(TOOL, 'not base64 json', run);
    expect(garbage.structuredContent.error).toMatch(/^Invalid payment/);
    const refused = await x402Paywall({ ...CFG, resourceServer: fakeServer({ valid: false }) }).call(TOOL, PAYMENT, run);
    expect(refused.structuredContent).toMatchObject({ error: 'Invalid payment: insufficient_funds', payer: '0xpayer', accepts: [ACCEPT] });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not charge a call whose tool fails', async () => {
    const s = fakeServer();
    const failed = { isError: true, content: [{ type: 'text', text: 'Chain not found' }] };
    expect(await x402Paywall({ ...CFG, resourceServer: s }).call(TOOL, PAYMENT, () => failed)).toBe(failed);
    expect(s.settlePayment).not.toHaveBeenCalled();
  });

  it('withholds the result when settlement fails', async () => {
    const res = await x402Paywall({ ...CFG, resourceServer: fakeServer({ settles: false }) }).call(TOOL, PAYMENT, () => ok);
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toBe('Settlement failed: nonce_used');
    expect(JSON.stringify(res)).not.toContain('hello');
  });

  it('retries the facilitator after it was unavailable', async () => {
    const s = fakeServer({ initFails: 1 });
    const paywall = x402Paywall({ ...CFG, resourceServer: s });
    const first = await paywall.call(TOOL, PAYMENT, () => ok);
    expect(first).toMatchObject({ isError: true, structuredContent: { error: 'Payment is temporarily unavailable', accepts: [] } });
    expect((await paywall.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response'].success).toBe(true);
    expect(s.initialize).toHaveBeenCalledTimes(2);
  });

  it('charges only requests addressed to a public domain', () => {
    const paywall = x402Paywall({ ...CFG, domains: ['chains-api.johnaverse.cc'] });
    expect(paywall.charges({ host: 'chains-api.johnaverse.cc' })).toBe(true);
    expect(paywall.charges({ host: 'Chains-API.johnaverse.cc:443' })).toBe(true);
    expect(paywall.charges({ host: 'chains-api.chains-api.svc.cluster.local:3001' })).toBe(false);
    expect(paywall.charges({ host: '10.42.0.17:3001' })).toBe(false);
    expect(paywall.charges({ host: '[::1]:3001' })).toBe(false);
    expect(paywall.charges({})).toBe(false);
    expect(x402Paywall(CFG).charges({ host: '10.42.0.17:3001' })).toBe(true);
  });

  it('reads the payment from _meta first, then the PAYMENT-SIGNATURE and X-PAYMENT headers', () => {
    const headers = { 'payment-signature': 'sig', 'x-payment': 'v1' };
    expect(paymentToken({ _meta: { 'x402/payment': 'meta' } }, { requestInfo: { headers } })).toBe('meta');
    expect(paymentToken({}, { requestInfo: { headers } })).toBe('sig');
    expect(paymentToken({}, { requestInfo: { headers: { 'x-payment': 'v1' } } })).toBe('v1');
    expect(paymentToken({}, {})).toBeUndefined();
  });
});

describe('MCP with x402 on', () => {
  const ORIGIN = 'https://chains.test';
  let store, facilitator, mcp, server, mcpUrl;

  beforeEach(async () => {
    store = memoryStore();
    facilitator = fakeServer();
    mcp = createMcpHttpApp({ publicOrigin: ORIGIN, authStore: store, x402: { ...CFG, resourceServer: facilitator } });
    server = await new Promise((resolve) => { const s = mcp.listen(0, '127.0.0.1', () => resolve(s)); });
    mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
  });
  afterEach(async () => {
    mcp.locals.stopSweeper();
    for (const t of Object.values(mcp.locals.transports ?? {})) await t.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  });

  // One JSON-RPC exchange; the transport may answer as JSON or as one SSE event.
  async function rpc(body, headers = {}) {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body })
    });
    const text = await res.text();
    const data = text.split('\n').find(l => l.startsWith('data: '));
    return { status: res.status, headers: res.headers, json: res.status === 202 || !text ? null : JSON.parse(data ? data.slice(6) : text) };
  }
  async function session(headers = {}) {
    const init = await rpc({ method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, headers);
    expect(init.status).toBe(200);
    const sid = { ...headers, 'mcp-session-id': init.headers.get('mcp-session-id') };
    await rpc({ method: 'notifications/initialized', id: undefined }, sid);
    return { init, call: (method, params) => rpc({ method, params }, sid) };
  }

  it('lets a client without a licence connect, prices the tools, and charges each call', async () => {
    const { init, call } = await session();
    expect(init.json.result.instructions).toContain('each tool call is paid with x402: 0.001 USD');
    const list = await call('tools/list', {});
    expect(list.json.result.tools[0]._meta).toEqual({ 'agents-x402/paymentRequired': true, 'agents-x402/priceUSD': 0.001 });

    const unpaid = await call('tools/call', { name: 'echo', arguments: {} });
    expect(unpaid.json.result).toMatchObject({ isError: true, structuredContent: { x402Version: 2, accepts: [ACCEPT] } });
    expect(unpaid.json.result.structuredContent.error).toMatch(/^Payment required\. Or use a licence key \(OAuth or a Bearer token\)/);
    expect(runTool).not.toHaveBeenCalled();

    const paid = await call('tools/call', { name: 'echo', arguments: {}, _meta: { 'x402/payment': base64(PAYMENT) } });
    expect(paid.json.result.content).toEqual(ok.content);
    expect(paid.json.result._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx' });
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('never charges a licensee', async () => {
    const { key } = await createLicenceKey('Acme', store);
    const { call } = await session({ authorization: `Bearer ${key}` });
    expect((await call('tools/list', {})).json.result.tools[0]._meta).toBeUndefined();
    const res = await call('tools/call', { name: 'echo', arguments: {} });
    expect(res.json.result).toEqual(ok);
    expect(facilitator.initialize).not.toHaveBeenCalled();
  });

  it('does not charge a call addressed to the service directly, as in-cluster callers do', async () => {
    const internal = createMcpHttpApp({ publicOrigin: ORIGIN, authStore: store, x402: { ...CFG, domains: ['chains.test'], resourceServer: facilitator } });
    const s = await new Promise((resolve) => { const l = internal.listen(0, '127.0.0.1', () => resolve(l)); });
    const saved = mcpUrl;
    mcpUrl = `http://127.0.0.1:${s.address().port}/mcp`;
    try {
      const { init, call } = await session();
      expect(init.json.result.instructions).not.toContain('x402');
      expect((await call('tools/list', {})).json.result.tools[0]._meta).toBeUndefined();
      expect((await call('tools/call', { name: 'echo', arguments: {} })).json.result).toEqual(ok);
      expect(facilitator.initialize).not.toHaveBeenCalled();
    } finally {
      mcpUrl = saved;
      internal.locals.stopSweeper();
      for (const t of Object.values(internal.locals.transports ?? {})) await t.close().catch(() => {});
      await new Promise((resolve) => s.close(resolve));
    }
  });

  it('still refuses an invalid token, and passes unknown tools through unpriced', async () => {
    expect((await rpc({ method: 'initialize', params: {} }, { authorization: `Bearer cak_${'z'.repeat(43)}` })).status).toBe(401);
    const { call } = await session();
    const res = await call('tools/call', { name: 'nope', arguments: {} });
    expect(res.json.result.content[0].text).toBe('Unknown tool: nope');
    expect(facilitator.initialize).not.toHaveBeenCalled();
  });
});
