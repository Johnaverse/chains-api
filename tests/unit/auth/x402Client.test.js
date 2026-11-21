import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  RATE_LIMIT_WINDOW_MS: 60000,
  MCP_RATE_LIMIT_MAX: 500,
  MCP_MAX_SESSIONS: 50,
  MCP_SESSION_IDLE_MS: 600000
}));
vi.mock('../../../dataService.js', () => ({
  initializeDataOnStartup: vi.fn(), startRpcHealthCheck: vi.fn(),
  getCachedData: () => ({ indexed: null, lastUpdated: null })
}));
const runTool = vi.fn();
vi.mock('../../../mcp-tools.js', () => ({
  getToolDefinitions: () => [{ name: 'get_chain_by_id', description: 'A chain', inputSchema: { type: 'object', properties: { chainId: { type: 'number' } } } }],
  handleToolCall: (_name, args) => runTool(args)
}));

import { verifyTypedData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { memoryLedger } from '../../../src/auth/x402Ledger.js';
import { memoryStore } from '../../../src/auth/store.js';
import { createMcpHttpApp } from '../../../mcp-server-http.js';

/**
 * The paywall as deployed: the real @x402/core resource server and EVM scheme, reaching a
 * facilitator over HTTP. The facilitator here checks what a real one checks before moving funds
 * (the EIP-3009 signature against the token's EIP-712 domain, recipient, amount, validity window)
 * and keeps the nonces it has spent. The client is the real @x402/core client with the EVM scheme,
 * signing with a real key: what an x402 MCP client sends.
 */
const NETWORK = 'eip155:84532';
const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const TRANSFER_WITH_AUTHORIZATION = [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }
];

function facilitatorServer() {
  const spent = new Map();
  const calls = [];
  async function check({ paymentPayload: p, paymentRequirements: r }) {
    const a = p?.payload?.authorization;
    if (!a || !p.payload.signature) return 'invalid_payload';
    const valid = await verifyTypedData({
      address: a.from,
      domain: { name: r.extra.name, version: r.extra.version, chainId: Number(r.network.split(':')[1]), verifyingContract: r.asset },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: 'TransferWithAuthorization',
      message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
      signature: p.payload.signature
    }).catch(() => false);
    if (!valid) return 'invalid_exact_evm_payload_signature';
    if (a.to.toLowerCase() !== r.payTo.toLowerCase() || BigInt(a.value) < BigInt(r.amount)) return 'invalid_exact_evm_payload_recipient_mismatch';
    const t = Math.floor(Date.now() / 1000);
    if (!(Number(a.validAfter) <= t && t < Number(a.validBefore))) return 'invalid_exact_evm_payload_authorization_valid_before';
    if (spent.has(a.nonce)) return 'invalid_exact_evm_nonce_already_used';
    return null;
  }
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    const send = (status, o) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    calls.push({ path: req.url, body: json });
    if (req.method === 'GET' && req.url === '/supported') return send(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} });
    const problem = await check(json);
    const payer = json?.paymentPayload?.payload?.authorization?.from;
    if (req.url === '/verify') return send(200, problem ? { isValid: false, invalidReason: problem, payer } : { isValid: true, payer });
    if (req.url === '/settle') {
      if (problem) return send(400, { success: false, errorReason: problem, transaction: '', network: NETWORK, payer });
      const transaction = `0x${(spent.size + 1).toString(16).padStart(64, '0')}`;
      spent.set(json.paymentPayload.payload.authorization.nonce, transaction);
      return send(200, { success: true, transaction, network: NETWORK, payer });
    }
    return send(404, {});
  });
  return { server, spent, calls };
}

describe('x402 over MCP with the real libraries', () => {
  let facilitator, app, mcp, base;
  const payer = privateKeyToAccount(generatePrivateKey());
  const client = registerExactEvmScheme(new x402Client(), { signer: payer });

  beforeAll(async () => {
    facilitator = facilitatorServer();
    await new Promise((resolve) => facilitator.server.listen(0, '127.0.0.1', resolve));
    app = createMcpHttpApp({
      publicOrigin: 'https://chains.test', authStore: memoryStore(),
      x402: {
        payTo: PAY_TO, network: NETWORK, priceUsd: 0.001,
        facilitatorUrl: `http://127.0.0.1:${facilitator.server.address().port}`,
        ledger: memoryLedger(), observe: async () => ({ state: 'unknown' })
      }
    });
    mcp = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${mcp.address().port}/mcp/pay`;
  });
  afterAll(async () => {
    app.locals.stopSweeper();
    for (const t of Object.values(app.locals.transports ?? {})) await t.close().catch(() => {});
    await new Promise((resolve) => mcp.close(resolve));
    await new Promise((resolve) => facilitator.server.close(resolve));
  });
  beforeEach(() => { runTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: '{"chainId":1}' }] }); });

  async function rpc(body, headers = {}) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body })
    });
    const text = await res.text();
    const data = text.split('\n').find(l => l.startsWith('data: '));
    return { res, json: res.status === 202 || !text ? null : JSON.parse(data ? data.slice(6) : text) };
  }
  async function session() {
    const { res } = await rpc({ method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x402-client', version: '0' } } });
    const sid = { 'mcp-session-id': res.headers.get('mcp-session-id') };
    await rpc({ method: 'notifications/initialized', id: undefined }, sid);
    return async (params) => (await rpc({ method: 'tools/call', params }, sid)).json.result;
  }
  const encode = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

  it('takes a payment signed by the x402 client, settles it once, and serves the call', async () => {
    const call = await session();
    const args = { chainId: 1 };
    const required = await call({ name: 'get_chain_by_id', arguments: args });
    expect(required.isError).toBe(true);
    const paymentRequired = required._meta['x402/error'];
    expect(paymentRequired.accepts[0]).toMatchObject({ scheme: 'exact', network: NETWORK, amount: '1000', payTo: PAY_TO });
    expect(runTool).not.toHaveBeenCalled();

    const payment = await client.createPaymentPayload(paymentRequired);
    expect(payment.payload.authorization.from).toBe(payer.address);
    const paid = await call({ name: 'get_chain_by_id', arguments: args, _meta: { 'x402/payment': encode(payment) } });
    expect(paid.isError).toBeUndefined();
    expect(paid.content[0].text).toBe('{"chainId":1}');
    expect(paid._meta['x402/payment-response']).toMatchObject({ success: true, network: NETWORK, payer: payer.address });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(facilitator.spent.size).toBe(1);
    expect(facilitator.calls.filter(c => c.path === '/settle')).toHaveLength(1);

    // The same payment again: answered for the same call without a second transfer.
    const again = await call({ name: 'get_chain_by_id', arguments: args, _meta: { 'x402/payment': payment } });
    expect(again._meta['x402/payment-response']).toMatchObject({ success: true, rerun: true });
    expect(facilitator.spent.size).toBe(1);
  });

  it('refuses a payment whose signature is not the payer\'s, or whose amount was lowered after signing, running nothing', async () => {
    const call = await session();
    const paymentRequired = (await call({ name: 'get_chain_by_id', arguments: {} }))._meta['x402/error'];
    const payment = await client.createPaymentPayload(paymentRequired);
    const other = privateKeyToAccount(generatePrivateKey());
    const forged = { ...payment, payload: { ...payment.payload, authorization: { ...payment.payload.authorization, from: other.address } } };
    const cheaper = { ...payment, payload: { ...payment.payload, authorization: { ...payment.payload.authorization, value: '1' } } };

    for (const bad of [forged, cheaper]) {
      const res = await call({ name: 'get_chain_by_id', arguments: {}, _meta: { 'x402/payment': encode(bad) } });
      expect(res.isError).toBe(true);
      expect(res._meta['x402/error'].accepts.length).toBeGreaterThan(0);
      expect(res._meta['x402/error'].error).toContain('invalid_exact_evm_payload_signature');
    }
    expect(runTool).not.toHaveBeenCalled();
    expect(facilitator.spent.size).toBe(1); // only the previous test's
  });
});
