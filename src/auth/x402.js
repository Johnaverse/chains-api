import { createHash } from 'node:crypto';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';
import { x402Ledger } from './x402Ledger.js';
import { observeAuthorization } from './x402Chain.js';

/**
 * x402 pay-per-call for MCP tools, per the x402 v2 MCP transport
 * (https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md):
 *
 * 1. A tool call without payment gets a tool result with `isError: true` whose
 *    `structuredContent` (and `content[0].text`, and `_meta["x402/error"]`, where Cloudflare's
 *    `withX402Client` reads it) is the `PaymentRequired` object: what to pay, in which asset, to whom.
 * 2. The client signs a payment and repeats the call with it in `params._meta["x402/payment"]`
 *    (an object, or base64 JSON as Cloudflare's client sends it; a `PAYMENT-SIGNATURE` or
 *    `X-PAYMENT` header works too).
 * 3. The facilitator verifies it, the tool runs, and only a successful result is settled; the
 *    settlement goes back in `_meta["x402/payment-response"]`. A failed tool is not charged.
 *
 * Every payment is recorded in a ledger shared by all pods (x402Ledger.js) before its tool runs.
 * When a settlement's outcome is lost (the facilitator did not answer, or answered "pending"),
 * the result is withheld but no new payment is asked for: the answer carries no `accepts`, and
 * says to retry with the same payment. That retry settles it again — the same authorization can
 * move funds only once — and, when the facilitator then says its nonce is spent, looks on-chain
 * (x402Chain.js) for whether that spend paid us. Only a definitive refusal asks for a new payment.
 *
 * The facilitator holds no funds and needs no key here; it only checks signatures and submits the
 * transfer. The asset (USDC on the configured network) and its amount come from @x402/evm.
 */
const SCHEME = 'exact';
const MAX_TIMEOUT_SECONDS = 300;
// After the facilitator could not be reached (or does not serve the network), calls are answered
// "temporarily unavailable" for this long before it is asked again, rather than once per call.
const RETRY_AFTER_MS = 30_000;
// A claimed payment whose call has not finished in this long is treated as unresolved: the pod
// handling it may have stopped mid-settlement.
const IN_FLIGHT_LEASE_MS = 120_000;
// Settled and refused payments are kept this long, for redelivery and audit.
const KEEP_MS = 24 * 60 * 60 * 1000;
// Facilitator reasons for a settlement that may still complete, and for an authorization whose
// nonce is already spent (by an earlier attempt of ours, or by anyone else).
const PENDING_REASON = 'settlement_pending';
const NONCE_USED = /nonce.*(already|used)/i;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function facilitatorServer(facilitatorUrl) {
  const [{ x402ResourceServer, HTTPFacilitatorClient }, { registerExactEvmScheme }] = await Promise.all([
    import('@x402/core/server'),
    import('@x402/evm/exact/server')
  ]);
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }));
  registerExactEvmScheme(server);
  return server;
}

function decodePayment(token) {
  if (token && typeof token === 'object') return token;
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** The host a request was addressed to, without its port or a trailing dot. */
function requestHost(headers) {
  const host = String(header(headers, 'host') ?? '').trim().toLowerCase();
  return (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')).replace(/\.$/, '');
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The payment a tools/call carries: request `_meta` first, then the HTTP headers. */
export function paymentToken(params, extra) {
  const headers = extra?.requestInfo?.headers;
  return params?._meta?.['x402/payment'] ?? header(headers, 'payment-signature') ?? header(headers, 'x-payment');
}

/**
 * Identity of a payment: its EIP-3009 authorization (payer + nonce on one token) when it has one,
 * which is what can move funds only once; otherwise the payload itself.
 */
function paymentId(payment, requirement) {
  const a = payment?.payload?.authorization;
  return a?.from && a?.nonce
    ? sha256(`${requirement.network}|${requirement.asset}|${a.from}|${a.nonce}`.toLowerCase())
    : sha256(JSON.stringify(payment?.payload ?? payment));
}

/** What a settle attempt says: settled, refused, nonce_used (spent: by whom?), or unresolved. */
function settleOutcome(result, err) {
  if (err) {
    // SettleError: the facilitator answered with a failed settlement; anything else lost its answer.
    if (err.name !== 'SettleError' || err.errorReason === PENDING_REASON) return { kind: 'unresolved', transaction: err.transaction || null };
    return { kind: NONCE_USED.test(err.errorReason ?? '') ? 'nonce_used' : 'refused', reason: err.errorReason };
  }
  if (result?.success) return { kind: 'settled', transaction: result.transaction, network: result.network, payer: result.payer };
  if (!result || result.errorReason === PENDING_REASON || !result.errorReason) return { kind: 'unresolved', transaction: result?.transaction || null };
  return { kind: NONCE_USED.test(result.errorReason) ? 'nonce_used' : 'refused', reason: result.errorReason };
}

/**
 * @param {object} cfg
 * @param {string} cfg.payTo           wallet that receives payments
 * @param {string} cfg.network         CAIP-2 network id
 * @param {number} cfg.priceUsd        price of one tool call
 * @param {string} cfg.facilitatorUrl  x402 facilitator (verify + settle)
 * @param {string[]} [cfg.domains]    hosts whose requests are charged; empty charges every request
 * @param {string} [cfg.alternative]   how to use the tools without paying, told to a client that hasn't paid
 * @param {object} [cfg.resourceServer] an x402ResourceServer stand-in (tests)
 * @param {object} [cfg.ledger]         payment ledger (x402Ledger.js)
 * @param {Function} [cfg.observe]      on-chain check of an authorization (x402Chain.js)
 * @param {() => number} [cfg.now]
 */
export function x402Paywall({
  payTo, network, priceUsd, facilitatorUrl, domains = [], alternative = '',
  resourceServer = null, ledger = x402Ledger(), observe = observeAuthorization, now = Date.now
}) {
  // The facilitator's supported kinds are read once; a failure is retried after RETRY_AFTER_MS.
  let ready = null;
  let failedAt = -Infinity;
  const server = () => {
    if (!ready && now() - failedAt < RETRY_AFTER_MS) return Promise.reject(new Error('facilitator unavailable; retrying later'));
    return (ready ??= (async () => {
      const s = resourceServer ?? await facilitatorServer(facilitatorUrl);
      await s.initialize();
      const accepts = await s.buildPaymentRequirements({ scheme: SCHEME, payTo, price: priceUsd, network, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS });
      // A price below the asset's smallest unit comes out as 0, which would give every call away.
      if (!accepts.length || accepts.some(a => !/^\d+$/.test(String(a.amount)) || BigInt(a.amount) <= 0n)) {
        throw new Error(`X402_PRICE_USD ${priceUsd} is no payable amount on ${network}`);
      }
      return { s, accepts };
    })().catch(err => { ready = null; failedAt = now(); throw err; }));
  };
  let purgedAt = 0;

  const count = (outcome) => incCounter('chains_api_x402_payments_total', { outcome });

  // The PaymentRequired body comes from the library, which applies each scheme's additions; when
  // the facilitator was unreachable there is no library server, and nothing to accept.
  async function paymentRequired(s, tool, accepts, error, fields = {}) {
    const resource = { url: `mcp://tool/${tool.name}`, description: tool.description ?? '', mimeType: 'application/json' };
    const message = alternative ? `${error}. ${alternative}` : error;
    const required = s ? await s.createPaymentRequiredResponse(accepts, resource, message) : { x402Version: 2, error: message, resource, accepts };
    const body = { ...required, ...fields };
    return { isError: true, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }], _meta: { 'x402/error': body } };
  }

  /**
   * The payment's outcome is not known yet. Not a PaymentRequired: there is nothing to accept, so
   * an x402 client does not sign a second payment; it is told to retry with the same one.
   */
  function pending(rec, why) {
    const response = { success: false, status: 'unresolved', network: rec.network, payer: rec.payer, ...(rec.transaction ? { transaction: rec.transaction } : {}) };
    const text = `${why} The tool result is withheld until the payment is resolved. Do not sign a new payment: retry this call with the same payment, which recovers it without paying twice.`;
    return { isError: true, content: [{ type: 'text', text }], _meta: { 'x402/payment-response': response } };
  }

  function receipt(result, rec, settled = {}) {
    return {
      ...result,
      _meta: { ...result?._meta, 'x402/payment-response': { success: true, transaction: rec.transaction, network: settled.network ?? rec.network, payer: settled.payer ?? rec.payer } }
    };
  }

  /**
   * Settle a claimed payment (rec is in_flight) whose tool already ran, or run it once paid.
   * `run` is called only once the payment is known to be settled.
   */
  async function settleClaimed(s, tool, accepts, payment, requirement, rec, run, { recovering }) {
    let outcome;
    try {
      outcome = settleOutcome(await s.settlePayment(payment, requirement));
    } catch (err) {
      outcome = settleOutcome(null, err);
    }
    if (outcome.kind === 'nonce_used' || (recovering && outcome.kind === 'unresolved')) {
      // Spent: by our earlier attempt, by the payer, or by a transfer elsewhere. The chain says which.
      const seen = await observe({ network: rec.network, asset: rec.asset, payer: rec.payer, nonce: rec.nonce, payTo: rec.payTo, amount: rec.amount });
      if (seen.state === 'paid') outcome = { kind: 'settled', transaction: seen.transaction };
      else if (seen.state === 'other') outcome = { kind: 'refused', reason: 'its nonce was spent on another transfer' };
      else if (seen.state === 'unused' && rec.validBefore && now() / 1000 > rec.validBefore) outcome = { kind: 'refused', reason: 'it expired unused' };
      else outcome = { kind: 'unresolved', transaction: outcome.transaction ?? rec.transaction };
    }
    const at = now();
    if (outcome.kind === 'settled') {
      await ledger.transition(rec, { status: 'settled', transaction: outcome.transaction ?? null, updatedAt: at });
      count(recovering ? 'recovered' : 'settled');
      logger.info({ tool: tool.name, payer: outcome.payer ?? rec.payer, transaction: outcome.transaction, network: outcome.network ?? rec.network, amount: rec.amount, asset: rec.asset, recovered: recovering }, 'x402 payment');
      return { settled: { ...rec, transaction: outcome.transaction ?? null }, outcome };
    }
    if (outcome.kind === 'refused') {
      await ledger.transition(rec, { status: 'refused', updatedAt: at });
      count('settlement_failed');
      return { result: await paymentRequired(s, tool, accepts, `Settlement failed${outcome.reason ? `: ${outcome.reason}` : ''}`) };
    }
    const unresolved = { ...rec, transaction: outcome.transaction ?? rec.transaction ?? null };
    await ledger.transition(rec, { status: 'unresolved', transaction: unresolved.transaction, updatedAt: at });
    count('unresolved');
    logger.warn({ tool: tool.name, payer: rec.payer, nonce: rec.nonce, transaction: unresolved.transaction, network: rec.network }, 'x402 payment unresolved');
    return { result: pending(unresolved, 'The payment\'s settlement could not be confirmed.') };
  }

  /** A payment the ledger already knows: in use, settled, refused, or to recover. */
  async function known(s, tool, accepts, payment, requirement, rec, argsHash, run) {
    if (rec.status === 'settled') {
      // Paid, but its result may not have reached the caller: the same call is answered again.
      if (rec.tool === tool.name && rec.argsHash === argsHash) {
        count('redelivered');
        return receipt(await run(), rec);
      }
      count('invalid');
      return paymentRequired(s, tool, accepts, 'Invalid payment: it has already paid for another call');
    }
    if (rec.status === 'refused') {
      count('invalid');
      return paymentRequired(s, tool, accepts, 'Invalid payment: it was refused');
    }
    if (rec.status === 'in_flight' && now() - rec.updatedAt < IN_FLIGHT_LEASE_MS) {
      count('busy');
      return pending(rec, 'This payment is in use by another call.');
    }
    // unresolved, or in flight on a pod that never finished: take it over and settle it again.
    const claimed = { ...rec, status: 'in_flight', tool: tool.name, argsHash, updatedAt: now() };
    if (!await ledger.transition(rec, { status: 'in_flight', tool: tool.name, argsHash, updatedAt: claimed.updatedAt })) {
      count('busy');
      return pending(rec, 'This payment is in use by another call.');
    }
    const done = await settleClaimed(s, tool, accepts, payment, requirement, claimed, run, { recovering: true });
    if (done.result) return done.result;
    return receipt(await run(), done.settled, done.outcome);
  }

  return {
    /**
     * Whether a request to these headers is charged: only one addressed to a public domain. The
     * gateway routes those hostnames alone to this service and passes the Host on, so a request
     * from outside always names one; in-cluster callers address the Service and go free. Anything
     * that came through Cloudflare (which sets CF-Connecting-IP) is charged whatever its Host.
     */
    charges: (headers) => !domains.length || domains.includes(requestHost(headers)) || Boolean(header(headers, 'cf-connecting-ip')),

    /** Shown on each tool in tools/list (Cloudflare's client adds the price to the description). */
    toolMeta: { 'agents-x402/paymentRequired': true, 'agents-x402/priceUSD': priceUsd },

    /**
     * Run one paid tool call. `tool` is { name, description }; `args` its arguments; `run`
     * produces the tool result. Returns the result with its receipt, the PaymentRequired result
     * when it was not (or could not be) paid, or a pending result when the payment is unresolved.
     */
    async call(tool, token, run, args = {}) {
      let s, accepts;
      try {
        ({ s, accepts } = await server());
      } catch (err) {
        logger.warn({ err: err.message, tool: tool.name }, 'x402 facilitator unavailable');
        count('unavailable');
        return paymentRequired(null, tool, [], 'Payment is temporarily unavailable');
      }
      if (!token) {
        count('required');
        return paymentRequired(s, tool, accepts, 'Payment required');
      }
      const payment = decodePayment(token);
      let requirement;
      try {
        requirement = payment && s.findMatchingRequirements(accepts, payment);
      } catch {
        requirement = null; // an x402Version the library does not know
      }
      if (!requirement) {
        count('invalid');
        return paymentRequired(s, tool, accepts, 'Invalid payment: it does not match what this tool accepts');
      }

      const authorization = payment.payload?.authorization ?? {};
      const argsHash = sha256(JSON.stringify(args ?? {}));
      const t = now();
      const rec = {
        id: paymentId(payment, requirement), tool: tool.name, argsHash,
        payer: authorization.from ?? null, nonce: authorization.nonce ?? null,
        network: requirement.network, asset: requirement.asset, amount: String(requirement.amount), payTo: requirement.payTo,
        validBefore: Number.isFinite(Number(authorization.validBefore)) ? Number(authorization.validBefore) : null,
        createdAt: t
      };
      try {
        if (t - purgedAt > 60 * 60 * 1000) { purgedAt = t; await ledger.purge(t - KEEP_MS); }
        if (!await ledger.claim(rec)) {
          const existing = await ledger.get(rec.id);
          if (existing) return await known(s, tool, accepts, payment, requirement, existing, argsHash, run);
          if (!await ledger.claim(rec)) return pending(rec, 'This payment is in use by another call.');
        }
      } catch (err) {
        // Without the ledger a lost settlement could not be recovered, so no payment is taken.
        logger.warn({ err: err.message, tool: tool.name }, 'x402 payment ledger unavailable');
        count('unavailable');
        return paymentRequired(null, tool, [], 'Payment is temporarily unavailable');
      }
      const claimed = { ...rec, status: 'in_flight', transaction: null, updatedAt: t };

      try {
        const verified = await s.verifyPayment(payment, requirement);
        if (!verified.isValid) {
          await ledger.release(rec.id);
          count('invalid');
          return paymentRequired(s, tool, accepts, `Invalid payment: ${verified.invalidReason ?? 'rejected by the facilitator'}`, verified.payer ? { payer: verified.payer } : {});
        }
      } catch (err) {
        await ledger.release(rec.id).catch(() => {});
        logger.warn({ err: err.message, tool: tool.name }, 'x402 verification failed');
        count('unavailable');
        return paymentRequired(s, tool, accepts, 'Payment could not be verified; try again');
      }

      const result = await run();
      if (result?.isError) {
        // Not charged, and the payment stays unspent: the caller may use it again.
        await ledger.release(rec.id).catch(() => {});
        count('not_charged');
        return result;
      }
      const done = await settleClaimed(s, tool, accepts, payment, requirement, claimed, run, { recovering: false });
      return done.result ?? receipt(result, done.settled, done.outcome);
    }
  };
}
