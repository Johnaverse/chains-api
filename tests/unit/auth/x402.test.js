import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// The tools the server lists: one stand-in, or the real registry's definitions where a test sets them.
const ECHO = [{ name: 'echo', description: 'Echo the input', inputSchema: { type: 'object', properties: {} } }];
const registry = vi.hoisted(() => ({ tools: [] }));
vi.mock('../../../mcp-tools.js', () => ({
  getToolDefinitions: () => registry.tools,
  handleToolCall: (name, args) => (registry.tools.some(t => t.name === name) ? runTool(args) : { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] })
}));

import { x402Paywall, paymentToken } from '../../../src/auth/x402.js';
import { memoryLedger } from '../../../src/auth/x402Ledger.js';
import { SettleError, VerifyError } from '@x402/core/types';
import { memoryStore } from '../../../src/auth/store.js';
import { createLicenceKey } from '../../../src/auth/licenceKeys.js';
import { createMcpHttpApp } from '../../../mcp-server-http.js';
import { renderMetrics, _resetMetricsForTests } from '../../../src/util/metrics.js';

const ACCEPT = { scheme: 'exact', network: 'eip155:84532', amount: '1000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
const NONCE = `0x${'ab'.repeat(32)}`;
const VALID_BEFORE = 2_000_000_000; // seconds; after every test clock below
const authorization = (nonce = NONCE) => ({ from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: ACCEPT.payTo, value: '1000', validAfter: '0', validBefore: String(VALID_BEFORE), nonce });
const paymentWith = (nonce) => ({ x402Version: 2, accepted: ACCEPT, payload: { signature: '0xsig', authorization: authorization(nonce) } });
const PAYMENT = paymentWith(NONCE);
// The same payment with every object's keys in reverse order.
const reordered = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).reverse().map(([k, v]) => [k, reordered(v)])) : o);
const CFG = { payTo: ACCEPT.payTo, network: ACCEPT.network, priceUsd: 0.001, facilitatorUrl: 'https://facilitator.test' };
const TOOL = { name: 'echo', description: 'Echo the input' };

const settleError = (errorReason, transaction = '') => new SettleError(500, { success: false, errorReason, transaction, network: ACCEPT.network });

/**
 * A stand-in for @x402/core's x402ResourceServer over a facilitator with a ledger of its own:
 * `chain` holds each authorization nonce it has spent (the transfer's effect), so tests count
 * effects, not calls. `settleAs` scripts how each settle attempt behaves:
 *   'ok'         settle and answer
 *   'lostBefore' the request is lost before anything happens
 *   'lostAfter'  the transfer happens, then the answer is lost
 *   'pending'    the transfer is broadcast, answered as settlement_pending with its hash
 *   'refuse'     a definitive refusal
 * A nonce already spent is refused as the EVM scheme does (invalid_exact_evm_nonce_already_used).
 */
function fakeServer({ valid = true, initFails = 0, settleAs = [], verifyFails = 0, verifyRejects = 0 } = {}) {
  let failures = initFails;
  let verifyFailures = verifyFails;
  let verifyRejections = verifyRejects;
  const chain = new Map(); // nonce -> transaction
  const script = [...settleAs];
  const s = {
    chain,
    initialize: vi.fn(async () => { if (failures-- > 0) throw new Error('facilitator down'); }),
    buildPaymentRequirements: vi.fn(async () => [ACCEPT]),
    findMatchingRequirements: vi.fn((accepts, p) => {
      if (p.x402Version !== 2) throw new Error(`Unsupported x402 version: ${p.x402Version}`);
      return accepts.find(a => a.network === p?.accepted?.network && a.payTo === p?.accepted?.payTo && a.amount === p?.accepted?.amount);
    }),
    createPaymentRequiredResponse: vi.fn(async (accepts, resource, error) => ({ x402Version: 2, error, resource, accepts })),
    verifyPayment: vi.fn(async (p) => {
      if (verifyFailures-- > 0) throw new Error('fetch failed');
      // How HTTPFacilitatorClient reports a rejection sent with an HTTP error status.
      if (verifyRejections-- > 0) throw new VerifyError(400, { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature', payer: p.payload.authorization.from });
      if (!valid) return { isValid: false, invalidReason: 'insufficient_funds', payer: p.payload.authorization.from };
      if (chain.has(p.payload.authorization.nonce)) return { isValid: false, invalidReason: 'invalid_exact_evm_nonce_already_used' };
      return { isValid: true, payer: p.payload.authorization.from };
    }),
    settlePayment: vi.fn(async (p) => {
      const nonce = p.payload.authorization.nonce;
      const mode = script.shift() ?? 'ok';
      if (mode === 'lostBefore') throw new Error('fetch failed');
      if (mode === 'refuse') throw settleError('invalid_exact_evm_payload_signature');
      if (chain.has(nonce)) throw settleError('invalid_exact_evm_nonce_already_used');
      const transaction = `0xtx${chain.size + 1}`;
      chain.set(nonce, transaction);
      if (mode === 'lostAfter') throw new Error('socket hang up');
      if (mode === 'pending') return { success: false, errorReason: 'settlement_pending', transaction, network: ACCEPT.network };
      return { success: true, transaction, network: ACCEPT.network, payer: p.payload.authorization.from };
    })
  };
  // What the chain shows for an authorization: the facilitator's own record of spent nonces.
  // Unspent proves nothing by itself (a node may lag): that takes an expired, finalized view, which tests set.
  // A transfer's block time (unix seconds) is `minedAt`: by default after every claim in the tests.
  s.minedAt = Infinity;
  s.observe = vi.fn(async ({ nonce }) => (chain.has(nonce) ? { state: 'paid', transaction: chain.get(nonce), time: s.minedAt } : { state: 'unknown' }));
  return s;
}
const paywallOf = (s, extra = {}) => x402Paywall({ ...CFG, resourceServer: s, ledger: memoryLedger(), observe: s.observe, ...extra });
const base64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const ok = { content: [{ type: 'text', text: 'hello' }] };
const metric = () => renderMetrics({ cache: {} });
// A result that asks for a (new) payment: what makes an x402 client sign one.
const asksForPayment = (res) => Array.isArray(res?._meta?.['x402/error']?.accepts) && res._meta['x402/error'].accepts.length > 0;

beforeEach(() => {
  registry.tools = ECHO;
  _resetMetricsForTests();
  runTool.mockReset().mockResolvedValue(ok);
});

describe('x402Paywall', () => {
  it('answers an unpaid call with PaymentRequired in all three places', async () => {
    const s = fakeServer();
    const run = vi.fn();
    const res = await paywallOf(s, { alternative: 'Or use a licence key' }).call(TOOL, undefined, run);
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
    expect(metric()).toContain('chains_api_x402_payments_total{outcome="required"} 1');
  });

  it.each([['an object', PAYMENT], ['base64 JSON', base64(PAYMENT)]])('verifies, runs and settles a payment sent as %s', async (_label, token) => {
    const s = fakeServer();
    const res = await paywallOf(s).call(TOOL, token, () => ok);
    expect(s.verifyPayment).toHaveBeenCalledWith(PAYMENT, ACCEPT);
    expect(s.settlePayment).toHaveBeenCalledWith(PAYMENT, ACCEPT);
    expect(res.content).toEqual(ok.content);
    expect(res._meta['x402/payment-response']).toEqual({ success: true, transaction: '0xtx1', network: ACCEPT.network, payer: PAYMENT.payload.authorization.from });
    expect(s.chain.size).toBe(1);
    expect(metric()).toContain('chains_api_x402_payments_total{outcome="settled"} 1');
  });

  it('rejects a payment that does not match, or that the facilitator refuses, without running the tool', async () => {
    const run = vi.fn();
    const wrong = await paywallOf(fakeServer()).call(TOOL, { ...PAYMENT, accepted: { ...ACCEPT, amount: '1' } }, run);
    expect(wrong.structuredContent.error).toMatch(/^Invalid payment/);
    const garbage = await paywallOf(fakeServer()).call(TOOL, 'not base64 json', run);
    expect(garbage.structuredContent.error).toMatch(/^Invalid payment/);
    const version = await paywallOf(fakeServer()).call(TOOL, { ...PAYMENT, x402Version: 3 }, run);
    expect(version.structuredContent.error).toMatch(/^Invalid payment/);
    const refused = await paywallOf(fakeServer({ valid: false })).call(TOOL, PAYMENT, run);
    expect(refused.structuredContent).toMatchObject({ error: 'Invalid payment: insufficient_funds', payer: PAYMENT.payload.authorization.from, accepts: [ACCEPT] });
    expect(run).not.toHaveBeenCalled();
  });

  it('does not charge a call whose tool fails, and the payment stays usable', async () => {
    const s = fakeServer();
    const paywall = paywallOf(s);
    const failed = { isError: true, content: [{ type: 'text', text: 'Chain not found' }] };
    expect(await paywall.call(TOOL, PAYMENT, () => failed)).toBe(failed);
    expect(s.settlePayment).not.toHaveBeenCalled();
    expect((await paywall.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response'].success).toBe(true);
  });

  it('asks for a new payment after a definitive refusal, withholding the result', async () => {
    const res = await paywallOf(fakeServer({ settleAs: ['refuse'] })).call(TOOL, PAYMENT, () => ok);
    expect(res.structuredContent.error).toBe('Settlement failed: invalid_exact_evm_payload_signature');
    expect(asksForPayment(res)).toBe(true);
    expect(JSON.stringify(res)).not.toContain('hello');
  });

  describe('when the settlement outcome is lost', () => {
    it.each([
      ['the request is lost before settlement', 'lostBefore', 0],
      ['the transfer happens, then the answer is lost', 'lostAfter', 1]
    ])('%s: withholds the result without asking for a new payment, and the same payment recovers it with one effect', async (_label, mode, effectsAfterFirst) => {
      const s = fakeServer({ settleAs: [mode] });
      const paywall = paywallOf(s);
      const run = vi.fn(() => ok);

      const first = await paywall.call(TOOL, PAYMENT, run, { q: 1 });
      expect(first.isError).toBe(true);
      expect(asksForPayment(first)).toBe(false);
      expect(first.structuredContent).toBeUndefined();
      expect(first._meta['x402/payment-response']).toMatchObject({ success: false, status: 'unresolved' });
      expect(first.content[0].text).toMatch(/Do not sign a new payment: retry this call with the same payment/);
      expect(JSON.stringify(first)).not.toContain('hello');
      expect(s.chain.size).toBe(effectsAfterFirst);

      const retry = await paywall.call(TOOL, base64(PAYMENT), run, { q: 1 });
      expect(retry.content).toEqual(ok.content);
      expect(retry._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(s.chain.size).toBe(1);
      expect(s.verifyPayment).toHaveBeenCalledTimes(1);
      expect(metric()).toContain('chains_api_x402_payments_total{outcome="recovered"} 1');
    });

    it('recovers only the call the payment was first used for, leaving it intact for that call', async () => {
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const ledger = memoryLedger();
      const paywall = x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe });
      const run = vi.fn(() => ok);
      await paywall.call(TOOL, PAYMENT, run, { chainId: 1 });
      const before = [...run.mock.calls].length;

      const changed = await paywall.call(TOOL, PAYMENT, run, { chainId: 2 });
      expect(changed.content[0].text).toMatch(/^This payment is pending for a different call/);
      expect(asksForPayment(changed)).toBe(false);
      const otherTool = await paywall.call({ ...TOOL, name: 'get_stats' }, PAYMENT, run, { chainId: 1 });
      expect(otherTool.content[0].text).toMatch(/^This payment is pending for a different call/);
      expect(run).toHaveBeenCalledTimes(before);
      expect(s.settlePayment).toHaveBeenCalledTimes(1);
      expect(metric()).toContain('chains_api_x402_payments_total{outcome="other_call"} 2');

      const original = await paywall.call(TOOL, PAYMENT, run, { chainId: 1 });
      expect(original._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1', rerun: true });
      expect(s.chain.size).toBe(1);
    });

    it('marks a recovered or redelivered answer as a fresh run of the tool, under the one receipt', async () => {
      let t = 0;
      let snapshot = 0;
      const run = () => ({ content: [{ type: 'text', text: `snapshot ${++snapshot}` }] });
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const paywall = paywallOf(s, { now: () => t });
      const first = await paywall.call(TOOL, PAYMENT, run);
      expect(JSON.stringify(first)).not.toContain('snapshot 1');
      const recovered = await paywall.call(TOOL, PAYMENT, run);
      expect(recovered.content[0].text).toBe('snapshot 2');
      expect(recovered._meta['x402/payment-response']).toEqual({ success: true, transaction: '0xtx1', network: ACCEPT.network, payer: PAYMENT.payload.authorization.from, rerun: true });
      t = 60_000;
      const again = await paywall.call(TOOL, PAYMENT, run);
      expect(again.content[0].text).toBe('snapshot 3');
      expect(again._meta['x402/payment-response']).toMatchObject({ transaction: '0xtx1', rerun: true });

      const fresh = await paywallOf(fakeServer()).call(TOOL, paymentWith(`0x${'cd'.repeat(32)}`), run);
      expect(fresh._meta['x402/payment-response'].rerun).toBeUndefined();
      expect(s.chain.size).toBe(1);
    });

    it('does not take a refusal during recovery at its word: the chain shows the first attempt paid', async () => {
      const s = fakeServer({ settleAs: ['lostAfter', 'refuse'] });
      const paywall = paywallOf(s);
      await paywall.call(TOOL, PAYMENT, () => ok);
      const retry = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(retry._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1', rerun: true });
      expect(s.observe).toHaveBeenCalled();
      expect(s.chain.size).toBe(1);
    });

    it('stays unresolved after a refusal during recovery when the chain cannot rule the first attempt out', async () => {
      const s = fakeServer({ settleAs: ['lostBefore', 'refuse'] });
      s.observe.mockResolvedValue({ state: 'unknown' });
      const paywall = paywallOf(s);
      await paywall.call(TOOL, PAYMENT, () => ok);
      const retry = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(asksForPayment(retry)).toBe(false);
      expect(retry._meta['x402/payment-response'].status).toBe('unresolved');
    });

    it('recovers the same call whatever the key order of its arguments', async () => {
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const paywall = paywallOf(s);
      await paywall.call(TOOL, PAYMENT, () => ok, { chainId: 1, filter: { tag: 'L2', limit: 10 } });
      const retry = await paywall.call(TOOL, reordered(PAYMENT), () => ok, { filter: { limit: 10, tag: 'L2' }, chainId: 1 });
      expect(retry._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
    });

    it('lets no one but the payer recover or answer with a recorded payment', async () => {
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const ledger = memoryLedger();
      const paywall = x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe });
      const run = vi.fn(() => ok);
      await paywall.call(TOOL, PAYMENT, run);
      // The authorization's payer and nonce are public once on-chain; the signature here is not the payer's.
      const forged = { ...PAYMENT, payload: { ...PAYMENT.payload, signature: '0xforged' } };
      const res = await paywall.call(TOOL, forged, run);
      expect(res.structuredContent.error).toMatch(/does not match the payment recorded/);
      expect(run).toHaveBeenCalledTimes(1);
      expect(s.settlePayment).toHaveBeenCalledTimes(1);
      const genuine = await paywall.call(TOOL, PAYMENT, run);
      expect(genuine._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(await paywall.call(TOOL, forged, run)).toMatchObject({ structuredContent: { error: expect.stringMatching(/does not match the payment recorded/) } });
    });

    it('keeps the transaction of a pending settlement and recovers through it', async () => {
      const s = fakeServer({ settleAs: ['pending'] });
      const paywall = paywallOf(s);
      const first = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(asksForPayment(first)).toBe(false);
      expect(first._meta['x402/payment-response']).toMatchObject({ status: 'unresolved', transaction: '0xtx1' });
      const retry = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(retry._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(s.chain.size).toBe(1);
    });

    it('stays unresolved, still without asking for a new payment, while nothing can be confirmed', async () => {
      const s = fakeServer({ settleAs: ['lostAfter', 'lostBefore'] });
      s.observe.mockResolvedValue({ state: 'unknown' });
      const paywall = paywallOf(s);
      await paywall.call(TOOL, PAYMENT, () => ok);
      const retry = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(asksForPayment(retry)).toBe(false);
      expect(retry._meta['x402/payment-response'].status).toBe('unresolved');
      expect(s.chain.size).toBe(1);
    });

    it('asks for a new payment once the chain shows the nonce paid someone else, or the authorization expired unused', async () => {
      const other = fakeServer({ settleAs: ['lostBefore', 'lostBefore'] });
      other.observe.mockResolvedValue({ state: 'other' });
      const a = paywallOf(other);
      await a.call(TOOL, PAYMENT, () => ok);
      const spent = await a.call(TOOL, PAYMENT, () => ok);
      expect(spent.structuredContent.error).toBe('Settlement failed: its nonce was spent on another transfer');
      expect(asksForPayment(spent)).toBe(true);

      const expired = fakeServer({ settleAs: ['lostBefore', 'refuse'] });
      expired.observe.mockResolvedValue({ state: 'expired_unused' });
      const b = paywallOf(expired);
      await b.call(TOOL, PAYMENT, () => ok);
      const late = await b.call(TOOL, PAYMENT, () => ok);
      expect(late.structuredContent.error).toBe('Settlement failed: it expired unused');
      expect(expired.observe).toHaveBeenLastCalledWith(expect.objectContaining({ validBefore: VALID_BEFORE }));
      expect(expired.chain.size).toBe(0);
    });

    describe('when the facilitator calls a payment spent on its first use', () => {
      // A facilitator that let a spent authorization through verification, or the same one used at
      // the same time against another deployment's ledger: its transfer paid us, but for that use.
      function spentAlready(minedAt) {
        const s = fakeServer();
        s.chain.set(NONCE, '0xold');
        s.minedAt = minedAt;
        s.verifyPayment.mockResolvedValueOnce({ isValid: true, payer: authorization().from });
        return s;
      }
      const at = (ms) => () => ms;

      it('credits no transfer mined before the payment was claimed here', async () => {
        // Claimed at 1000 s; mined a minute earlier, beyond the 30 s allowed for clock skew.
        const s = spentAlready(1_000 - 60);
        const res = await paywallOf(s, { now: at(1_000_000) }).call(TOOL, PAYMENT, () => ok);
        expect(res.structuredContent.error).toBe('Settlement failed: it was spent before this call took it');
        expect(asksForPayment(res)).toBe(true);
        expect(res.content).not.toEqual(ok.content);
      });

      it('credits one mined after the claim (a facilitator that retried its own submission)', async () => {
        const res = await paywallOf(spentAlready(1_000 - 5), { now: at(1_000_000) }).call(TOOL, PAYMENT, () => ok);
        expect(res.content).toEqual(ok.content);
        expect(res._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xold' });
      });

      it('stays unresolved when the block time is unknown', async () => {
        const res = await paywallOf(spentAlready(Number.NaN), { now: at(1_000_000) }).call(TOOL, PAYMENT, () => ok);
        expect(asksForPayment(res)).toBe(false);
        expect(res._meta['x402/payment-response']).toMatchObject({ success: false, status: 'unresolved' });
      });
    });

    it('checks the chain through the trusted RPC endpoints when they are set', async () => {
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const urls = ['https://a.rpc.test', 'https://b.rpc.test'];
      const paywall = paywallOf(s, { rpcUrls: urls });
      await paywall.call(TOOL, PAYMENT, () => ok);
      expect((await paywall.call(TOOL, PAYMENT, () => ok)).content).toEqual(ok.content);
      expect(s.observe).toHaveBeenLastCalledWith(expect.objectContaining({ nonce: NONCE }), { urls });
    });

    it('never asks a payer whose pending settlement went through to pay again, while the chain cannot prove otherwise', async () => {
      // epistemedeus's case: settlement_pending with a hash, the retry refused after expiry, and an
      // on-chain view that can neither confirm the transfer nor prove the authorization unused.
      const s = fakeServer({ settleAs: ['pending', 'refuse'] });
      const paywall = paywallOf(s);
      const first = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(first._meta['x402/payment-response']).toMatchObject({ status: 'unresolved', transaction: '0xtx1' });
      s.observe.mockResolvedValue({ state: 'unknown' });
      const retry = await paywall.call(TOOL, PAYMENT, () => ok);
      expect(asksForPayment(retry)).toBe(false);
      expect(retry._meta['x402/payment-response']).toMatchObject({ status: 'unresolved', transaction: '0xtx1' });
      expect(s.observe).toHaveBeenLastCalledWith(expect.objectContaining({ transaction: '0xtx1' }));
    });

    it('is recovered by another pod sharing the ledger', async () => {
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const ledger = memoryLedger();
      await x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }).call(TOOL, PAYMENT, () => ok);
      const other = x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe });
      expect((await other.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(s.chain.size).toBe(1);
    });

    it('charges nothing when the tool of a taken-over call fails, and settles once it succeeds', async () => {
      let t = 0;
      const s = fakeServer();
      const ledger = memoryLedger();
      const pod = () => x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe, now: () => t });
      const stuck = vi.fn(() => new Promise(() => {}));
      pod().call(TOOL, PAYMENT, stuck);
      await vi.waitFor(() => expect(stuck).toHaveBeenCalled());
      t = 121_000;
      const other = pod();
      const failed = { isError: true, content: [{ type: 'text', text: 'Chain not found' }] };
      expect(await other.call(TOOL, PAYMENT, () => failed)).toBe(failed);
      expect(s.settlePayment).not.toHaveBeenCalled();
      await expect(other.call(TOOL, PAYMENT, () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(s.settlePayment).not.toHaveBeenCalled();
      expect((await other.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(s.chain.size).toBe(1);
    });

    it.each([
      ['answers that it is spent', 'spent'],
      ['fails to answer', 'down']
    ])('does not ask for a new payment when a verification that outlived its lease %s after a takeover settled', async (_label, how) => {
      let t = 0;
      const s = fakeServer();
      const ledger = memoryLedger();
      const pod = () => x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe, now: () => t });
      const verify = s.verifyPayment.getMockImplementation();
      let finish = null;
      s.verifyPayment.mockImplementationOnce((p) => new Promise((resolve, reject) => {
        finish = () => (how === 'down' ? reject(new Error('fetch failed')) : resolve(verify(p)));
      }));
      const original = pod().call(TOOL, PAYMENT, () => ok);
      await vi.waitFor(() => expect(finish).not.toBeNull());
      t = 121_000;
      expect((await pod().call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      finish();
      const res = await original;
      expect(asksForPayment(res)).toBe(false);
      expect(res._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1', rerun: true });
      expect(s.chain.size).toBe(1);
    });

    it('does not ask for a new payment when a call that outlived its lease is refused after its takeover settled', async () => {
      let t = 0;
      // The takeover settles first; the original call's own attempt is then refused (say, expired).
      const s = fakeServer({ settleAs: ['ok', 'refuse'] });
      const ledger = memoryLedger();
      const claim = vi.spyOn(ledger, 'claim');
      const pod = () => x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe, now: () => t });
      let finish;
      const slow = vi.fn(() => new Promise((resolve) => { finish = () => resolve(ok); }));
      const original = pod().call(TOOL, PAYMENT, slow);
      await vi.waitFor(() => expect(slow).toHaveBeenCalled());
      t = 121_000;
      expect((await pod().call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      finish();
      const res = await original;
      expect(asksForPayment(res)).toBe(false);
      expect(res.content).toEqual(ok.content);
      expect(res._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(s.chain.size).toBe(1);
      // The record is the takeover's: the refusal did not overwrite it.
      expect((await ledger.get(claim.mock.calls[0][0].id)).status).toBe('settled');
    });

    it('leaves a refused call that lost its claim pending while its takeover is unresolved', async () => {
      let t = 0;
      const s = fakeServer({ settleAs: ['lostBefore', 'refuse'] });
      const ledger = memoryLedger();
      const pod = () => x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe, now: () => t });
      let finish;
      const slow = vi.fn(() => new Promise((resolve) => { finish = () => resolve(ok); }));
      const original = pod().call(TOOL, PAYMENT, slow);
      await vi.waitFor(() => expect(slow).toHaveBeenCalled());
      t = 121_000;
      await pod().call(TOOL, PAYMENT, () => ok);
      finish();
      const res = await original;
      expect(asksForPayment(res)).toBe(false);
      expect(res._meta['x402/payment-response']).toMatchObject({ success: false, status: 'unresolved' });
      expect(JSON.stringify(res)).not.toContain('hello');
    });

    it('checks a payment taken on another network through that network\'s registry endpoints, not the trusted ones', async () => {
      // Taken on Base Sepolia, its answer lost; the next pod runs on Base with Base's trusted RPCs.
      const s = fakeServer({ settleAs: ['lostAfter'] });
      const ledger = memoryLedger();
      await x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }).call(TOOL, PAYMENT, () => ok);
      s.buildPaymentRequirements.mockResolvedValue([{ ...ACCEPT, network: 'eip155:8453' }]);
      const urls = ['https://base-a.rpc.test', 'https://base-b.rpc.test'];
      const pod = x402Paywall({ ...CFG, network: 'eip155:8453', rpcUrls: urls, resourceServer: s, ledger, observe: s.observe });
      expect((await pod.call(TOOL, PAYMENT, () => ok)).content).toEqual(ok.content);
      expect(s.observe.mock.lastCall).toEqual([expect.objectContaining({ network: 'eip155:84532' })]);
    });

    describe('after the price changed', () => {
      const DEARER = { ...ACCEPT, amount: '2000' };
      // One pod took the payment at the old price and lost its settlement's answer; the next was
      // started with the new price.
      async function repriced() {
        const s = fakeServer({ settleAs: ['lostAfter'] });
        const ledger = memoryLedger();
        await x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }).call(TOOL, PAYMENT, () => ok);
        s.buildPaymentRequirements.mockResolvedValue([DEARER]);
        return { s, pod: x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }) };
      }

      it('recovers a recorded payment on the terms it was taken under', async () => {
        const { s, pod } = await repriced();
        const res = await pod.call(TOOL, PAYMENT, () => ok);
        expect(res._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
        expect(s.settlePayment).toHaveBeenLastCalledWith(PAYMENT, ACCEPT);
        expect(s.chain.size).toBe(1);
      });

      it('takes no new payment at the old price, and none whose terms differ from its record', async () => {
        const { s, pod } = await repriced();
        const run = vi.fn();
        const stale = await pod.call(TOOL, paymentWith(`0x${'cd'.repeat(32)}`), run);
        expect(stale.structuredContent.error).toBe('Invalid payment: it does not match what this tool accepts');
        expect(stale.structuredContent.accepts).toEqual([DEARER]);
        // The recorded payload, relabelled with today's terms.
        const relabelled = await pod.call(TOOL, { ...PAYMENT, accepted: DEARER }, run);
        expect(relabelled.structuredContent.error).toMatch(/does not match the payment recorded/);
        expect(run).not.toHaveBeenCalled();
        expect(s.verifyPayment).toHaveBeenCalledTimes(1);
        expect(s.chain.size).toBe(1);
      });
    });

    it('takes over a payment left in flight by a pod that stopped mid-call', async () => {
      let t = 0;
      const s = fakeServer();
      const ledger = memoryLedger();
      const pod = () => x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe, now: () => t });
      const stuck = vi.fn(() => new Promise(() => {}));
      pod().call(TOOL, PAYMENT, stuck);
      await vi.waitFor(() => expect(stuck).toHaveBeenCalled());
      const other = pod();
      expect((await other.call(TOOL, PAYMENT, () => ok)).content[0].text).toMatch(/^This payment is in use by another call/);
      t = 121_000;
      expect((await other.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
      expect(s.chain.size).toBe(1);
    });
  });

  it('treats the same payment with reordered keys as the same payment', async () => {
    const s = fakeServer();
    const paywall = paywallOf(s);
    let release;
    const run = vi.fn(() => new Promise(resolve => { release = () => resolve(ok); }));
    const first = paywall.call(TOOL, PAYMENT, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const copy = await paywall.call(TOOL, base64(reordered(PAYMENT)), run);
    expect(copy.content[0].text).toMatch(/^This payment is in use by another call/);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.verifyPayment).toHaveBeenCalledTimes(1);
  });

  it('treats a rejection thrown as VerifyError as an invalid payment, with no pause for others', async () => {
    const s = fakeServer({ verifyRejects: 1 });
    const paywall = paywallOf(s);
    const bad = await paywall.call(TOOL, paymentWith(`0x${'ef'.repeat(32)}`), () => ok);
    expect(bad.structuredContent).toMatchObject({ error: 'Invalid payment: invalid_exact_evm_payload_signature', accepts: [ACCEPT] });
    expect(metric()).toContain('chains_api_x402_payments_total{outcome="invalid"} 1');
    expect((await paywall.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response'].success).toBe(true);
  });

  it('takes no payments for a while after the facilitator failed to verify one', async () => {
    let t = 0;
    const s = fakeServer({ verifyFails: 1 });
    const paywall = paywallOf(s, { now: () => t });
    expect((await paywall.call(TOOL, PAYMENT, () => ok)).structuredContent.error).toMatch(/^Payment could not be verified/);
    t = 10_000;
    expect((await paywall.call(TOOL, PAYMENT, () => ok)).structuredContent).toMatchObject({ error: 'Payment is temporarily unavailable', accepts: [] });
    expect(s.verifyPayment).toHaveBeenCalledTimes(1);
    t = 31_000;
    expect((await paywall.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response'].success).toBe(true);
  });

  it('refuses a payment in use by another call without asking for a new one, and frees it afterwards', async () => {
    const s = fakeServer();
    const paywall = paywallOf(s);
    let release;
    const run = vi.fn(() => new Promise(resolve => { release = () => resolve(ok); }));
    const first = paywall.call(TOOL, PAYMENT, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const second = await paywall.call(TOOL, base64(PAYMENT), run);
    expect(second.content[0].text).toMatch(/^This payment is in use by another call/);
    expect(asksForPayment(second)).toBe(false);
    release();
    expect((await first)._meta['x402/payment-response'].success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.chain.size).toBe(1);
  });

  it('answers the same paid call again for a few minutes without charging, but not a different one', async () => {
    let t = 0;
    const s = fakeServer();
    const paywall = paywallOf(s, { now: () => t });
    await paywall.call(TOOL, PAYMENT, () => ok, { chainId: 1 });
    t = 4 * 60_000;
    const again = await paywall.call(TOOL, PAYMENT, () => ok, { chainId: 1 });
    expect(again._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
    const another = await paywall.call(TOOL, PAYMENT, () => ok, { chainId: 2 });
    expect(another.structuredContent.error).toMatch(/already been spent/);
    t = 6 * 60_000;
    const late = await paywall.call(TOOL, PAYMENT, () => ok, { chainId: 1 });
    expect(late.structuredContent.error).toMatch(/already been spent/);
    expect(s.settlePayment).toHaveBeenCalledTimes(1);
    expect(s.chain.size).toBe(1);
  });

  it('answers a settled call even when the ledger cannot record it', async () => {
    const s = fakeServer();
    const ledger = memoryLedger();
    ledger.transition = vi.fn(async () => { throw new Error('db down'); });
    const res = await x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }).call(TOOL, PAYMENT, () => ok);
    expect(res.content).toEqual(ok.content);
    expect(res._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
  });

  it('frees a payment whose tool threw, so it can be used again at once', async () => {
    const s = fakeServer();
    const paywall = paywallOf(s);
    await expect(paywall.call(TOOL, PAYMENT, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await paywall.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response'].success).toBe(true);
    expect(s.chain.size).toBe(1);
  });

  it('takes payments while purging old records fails', async () => {
    const s = fakeServer();
    const ledger = memoryLedger();
    ledger.purge = vi.fn(async () => { throw new Error('db busy'); });
    const res = await x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }).call(TOOL, PAYMENT, () => ok);
    expect(res._meta['x402/payment-response'].success).toBe(true);
    expect(ledger.purge).toHaveBeenCalled();
  });

  it('takes no payment while the ledger is unavailable', async () => {
    const s = fakeServer();
    const ledger = { ...memoryLedger(), claim: vi.fn(async () => { throw new Error('db down'); }) };
    const run = vi.fn();
    const res = await x402Paywall({ ...CFG, resourceServer: s, ledger, observe: s.observe }).call(TOOL, PAYMENT, run);
    expect(res.structuredContent).toMatchObject({ error: 'Payment is temporarily unavailable', accepts: [] });
    expect(run).not.toHaveBeenCalled();
    expect(s.verifyPayment).not.toHaveBeenCalled();
  });

  it('asks an unavailable facilitator again only after a pause', async () => {
    let t = 0;
    const s = fakeServer({ initFails: 1 });
    const paywall = paywallOf(s, { now: () => t });
    const first = await paywall.call(TOOL, PAYMENT, () => ok);
    expect(first).toMatchObject({ isError: true, structuredContent: { error: 'Payment is temporarily unavailable', accepts: [] } });
    t = 29_000;
    expect((await paywall.call(TOOL, PAYMENT, () => ok)).structuredContent.error).toBe('Payment is temporarily unavailable');
    expect(s.initialize).toHaveBeenCalledTimes(1);
    t = 31_000;
    expect((await paywall.call(TOOL, PAYMENT, () => ok))._meta['x402/payment-response'].success).toBe(true);
    expect(s.initialize).toHaveBeenCalledTimes(2);
  });

  it('takes no payment of 0: a price that rounds to nothing leaves payment unavailable', async () => {
    const s = fakeServer();
    s.buildPaymentRequirements.mockResolvedValue([{ ...ACCEPT, amount: '0' }]);
    const run = vi.fn();
    const res = await paywallOf(s).call(TOOL, PAYMENT, run);
    expect(res.structuredContent).toMatchObject({ error: 'Payment is temporarily unavailable', accepts: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('frees only a request that is provably in-cluster, and charges everything else', () => {
    const paywall = paywallOf(fakeServer(), { domains: ['chains-api.johnaverse.cc'] });
    const pod = '10.42.0.9';
    // A public domain pays, from anywhere.
    expect(paywall.charges({ host: 'chains-api.johnaverse.cc' }, pod)).toBe(true);
    expect(paywall.charges({ host: 'Chains-API.johnaverse.cc:443' }, pod)).toBe(true);
    expect(paywall.charges({ host: 'chains-api.johnaverse.cc.' }, pod)).toBe(true);
    // An in-cluster caller addressing the Service, a pod or loopback directly is free.
    expect(paywall.charges({ host: 'chains-api.chains-api.svc.cluster.local:3001' }, pod)).toBe(false);
    expect(paywall.charges({ host: '10.42.0.17:3001' }, '::ffff:10.42.0.9')).toBe(false);
    expect(paywall.charges({ host: '[::1]:3001' }, '::1')).toBe(false);
    expect(paywall.charges({}, '127.0.0.1')).toBe(false);
    // Any other host pays unless the request came straight from a private address: one through
    // Cloudflare or a proxy, from a public address, or of unknown origin.
    for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'x-real-ip']) {
      expect(paywall.charges({ host: 'chains-api.chains-api.svc:3001', [name]: '203.0.113.9' }, pod), name).toBe(true);
    }
    expect(paywall.charges({ host: 'chains-api.example.org' }, '203.0.113.9')).toBe(true);
    expect(paywall.charges({ host: 'chains-api.example.org' }, undefined)).toBe(true);
    expect(paywall.charges({ host: 'chains-api.chains-api.svc:3001' })).toBe(true);
    // No domains: everything pays.
    expect(paywallOf(fakeServer()).charges({ host: '10.42.0.17:3001' }, pod)).toBe(true);
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
  let store, facilitator, apps, base;

  async function start(x402) {
    const app = createMcpHttpApp({ publicOrigin: ORIGIN, authStore: store, x402: { ...CFG, resourceServer: facilitator, ledger: memoryLedger(), observe: facilitator.observe, ...x402 } });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    apps.push({ app, server });
    return `http://127.0.0.1:${server.address().port}`;
  }
  beforeEach(async () => {
    store = memoryStore();
    facilitator = fakeServer();
    apps = [];
    base = await start({});
  });
  afterEach(async () => {
    for (const { app, server } of apps) {
      app.locals.stopSweeper();
      for (const t of Object.values(app.locals.transports ?? {})) await t.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // One JSON-RPC exchange; the transport may answer as JSON or as one SSE event.
  async function rpc(url, body, headers = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body })
    });
    const text = await res.text();
    const data = text.split('\n').find(l => l.startsWith('data: '));
    return { status: res.status, headers: res.headers, json: res.status === 202 || !text ? null : JSON.parse(data ? data.slice(6) : text) };
  }
  const initialize = (url, headers) => rpc(url, { method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, headers);
  async function session(url, headers = {}) {
    const init = await initialize(url, headers);
    expect(init.status).toBe(200);
    const sid = { ...headers, 'mcp-session-id': init.headers.get('mcp-session-id') };
    await rpc(url, { method: 'notifications/initialized', id: undefined }, sid);
    return { init, call: (method, params) => rpc(url, { method, params }, sid) };
  }

  it('keeps the licence challenge on /mcp, pointing to /mcp/pay', async () => {
    const res = await initialize(`${base}/mcp`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(res.json.error.message).toContain(`pay per tool call with x402 at ${ORIGIN}/mcp/pay`);
    expect((await initialize(`${base}/mcp/pay`, { authorization: `Bearer cak_${'z'.repeat(43)}` })).status).toBe(401);
  });

  it('lets a client without a licence connect on /mcp/pay, prices the tools, and charges each call', async () => {
    const { init, call } = await session(`${base}/mcp/pay`);
    expect(init.json.result.instructions).toContain('each tool call is paid with x402: 0.001 USD');
    const list = await call('tools/list', {});
    expect(list.json.result.tools[0]._meta).toEqual({ 'agents-x402/paymentRequired': true, 'agents-x402/priceUSD': 0.001 });

    const unpaid = await call('tools/call', { name: 'echo', arguments: {} });
    expect(unpaid.json.result).toMatchObject({ isError: true, structuredContent: { x402Version: 2, accepts: [ACCEPT] } });
    expect(unpaid.json.result.structuredContent.error).toBe(`Payment required. Or connect to ${ORIGIN}/mcp with a licence key (OAuth or a Bearer token): licensing@johnaverse.cc. Terms: https://chains-api.johnaverse.cc/terms`);
    expect(runTool).not.toHaveBeenCalled();

    const paid = await call('tools/call', { name: 'echo', arguments: {}, _meta: { 'x402/payment': base64(PAYMENT) } });
    expect(paid.json.result.content).toEqual(ok.content);
    expect(paid.json.result._meta['x402/payment-response']).toMatchObject({ success: true, transaction: '0xtx1' });
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('prices every tool of the registry, runs none unpaid, and settles one payment for each', async () => {
    registry.tools = (await vi.importActual('../../../mcp-tools.js')).getToolDefinitions();
    const names = registry.tools.map(t => t.name);
    expect(names.length).toBeGreaterThan(30);
    const { call } = await session(`${base}/mcp/pay`);
    const listed = (await call('tools/list', {})).json.result.tools;
    expect(listed.map(t => t.name)).toEqual(names);
    expect(listed.filter(t => t._meta?.['agents-x402/paymentRequired'] === true && t._meta['agents-x402/priceUSD'] === 0.001).length).toBe(names.length);

    for (const [i, name] of names.entries()) {
      const unpaid = await call('tools/call', { name, arguments: {} });
      expect(asksForPayment(unpaid.json.result), name).toBe(true);
      expect(runTool, name).toHaveBeenCalledTimes(i);
      const paid = await call('tools/call', { name, arguments: {}, _meta: { 'x402/payment': paymentWith(`0x${(i + 1).toString(16).padStart(64, '0')}`) } });
      expect(paid.json.result._meta['x402/payment-response'], name).toMatchObject({ success: true, transaction: `0xtx${i + 1}` });
    }
    expect(runTool).toHaveBeenCalledTimes(names.length);
    expect(facilitator.chain.size).toBe(names.length);
  });

  it('lets sessions without a licence hold only half of the session limit, leaving room for licensees', async () => {
    for (let i = 0; i < 25; i++) expect((await initialize(`${base}/mcp/pay`)).status).toBe(200);
    const refused = await initialize(`${base}/mcp/pay`);
    expect(refused.status).toBe(503);
    expect(refused.json.error.message).toContain('Too many open sessions');
    const { key } = await createLicenceKey('Acme', store);
    expect((await initialize(`${base}/mcp`, { authorization: `Bearer ${key}` })).status).toBe(200);
  });

  it.each(['/mcp', '/mcp/pay'])('never charges a licensee on %s', async (path) => {
    const { key } = await createLicenceKey('Acme', store);
    const { init, call } = await session(`${base}${path}`, { authorization: `Bearer ${key}` });
    expect(init.json.result.instructions).not.toContain('x402');
    expect((await call('tools/list', {})).json.result.tools[0]._meta).toBeUndefined();
    expect((await call('tools/call', { name: 'echo', arguments: {} })).json.result).toEqual(ok);
    expect(facilitator.initialize).not.toHaveBeenCalled();
  });

  it('lets a call addressed to the service directly, as in-cluster callers do, through free', async () => {
    const internal = await start({ domains: ['chains.test'] });
    const { init, call } = await session(`${internal}/mcp`);
    expect(init.json.result.instructions).not.toContain('x402');
    expect((await call('tools/list', {})).json.result.tools[0]._meta).toBeUndefined();
    expect((await call('tools/call', { name: 'echo', arguments: {} })).json.result).toEqual(ok);
    expect(facilitator.initialize).not.toHaveBeenCalled();
    // The same request through Cloudflare is charged, and /mcp challenges it.
    expect((await initialize(`${internal}/mcp`, { 'cf-connecting-ip': '203.0.113.9' })).status).toBe(401);
  });

  it('decides each request of a session on its own: one that came through a proxy pays', async () => {
    const internal = await start({ domains: ['chains.test'] });
    const init = await initialize(`${internal}/mcp/pay`);
    const sid = { 'mcp-session-id': init.headers.get('mcp-session-id') };
    await rpc(`${internal}/mcp/pay`, { method: 'notifications/initialized', id: undefined }, sid);
    const callWith = (headers) => rpc(`${internal}/mcp/pay`, { method: 'tools/call', params: { name: 'echo', arguments: {} } }, { ...sid, ...headers });

    expect((await callWith({})).json.result).toEqual(ok);
    for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip']) {
      expect(asksForPayment((await callWith({ [name]: '203.0.113.9' })).json.result), name).toBe(true);
    }
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('passes unknown tools through unpriced', async () => {
    const { call } = await session(`${base}/mcp/pay`);
    const res = await call('tools/call', { name: 'nope', arguments: {} });
    expect(res.json.result.content[0].text).toBe('Unknown tool: nope');
    expect(facilitator.initialize).not.toHaveBeenCalled();
  });

  it('serves no /mcp/pay with x402 off', async () => {
    const off = createMcpHttpApp({ publicOrigin: ORIGIN, authStore: store, x402: null });
    const server = await new Promise((resolve) => { const s = off.listen(0, '127.0.0.1', () => resolve(s)); });
    apps.push({ app: off, server });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});
