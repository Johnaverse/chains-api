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
// How long after its settlement a paid call is answered again for the same payment (its answer
// may have been lost on the way back); after that the payment is spent.
const REDELIVER_MS = 5 * 60 * 1000;
// Settled and refused payments are kept this long, for audit; purged at most once an hour.
const KEEP_MS = 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
// Facilitator reasons for a settlement that may still complete, and for an authorization whose
// nonce is already spent (by an earlier attempt of ours, or by anyone else) — the schemes' names
// end so, e.g. invalid_exact_evm_nonce_already_used.
const PENDING_REASON = 'settlement_pending';
const NONCE_USED = /nonce_already_used$/;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted at every level: equal values, whatever their key order, hash alike. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

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
    : sha256(canonical(payment?.payload ?? payment));
}

/**
 * What a settle attempt says: settled, refused, nonce_used (spent: by whom?), or unresolved.
 * A SettleError is the facilitator answering with a failed settlement; any other error lost its
 * answer, so the outcome is unknown.
 */
function settleOutcome(result, err, SettleError) {
  const failure = err instanceof SettleError ? err : (!err && !result?.success ? result : null);
  if (err && !failure) return { kind: 'unresolved', transaction: null };
  if (!failure) return { kind: 'settled', transaction: result.transaction, network: result.network, payer: result.payer };
  if (!failure.errorReason || failure.errorReason === PENDING_REASON) return { kind: 'unresolved', transaction: failure.transaction || null };
  return { kind: NONCE_USED.test(failure.errorReason) ? 'nonce_used' : 'refused', reason: failure.errorReason };
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
  const facilitator = () => {
    if (!ready && now() - failedAt < RETRY_AFTER_MS) return Promise.reject(new Error('facilitator unavailable; retrying later'));
    return (ready ??= (async () => {
      const [s, { SettleError, VerifyError }] = await Promise.all([resourceServer ?? facilitatorServer(facilitatorUrl), import('@x402/core/types')]);
      await s.initialize();
      const accepts = await s.buildPaymentRequirements({ scheme: SCHEME, payTo, price: priceUsd, network, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS });
      // A price below the asset's smallest unit comes out as 0, which would give every call away.
      if (!accepts.length || accepts.some(a => !/^\d+$/.test(String(a.amount)) || BigInt(a.amount) <= 0n)) {
        throw new Error(`X402_PRICE_USD ${priceUsd} is no payable amount on ${network}`);
      }
      return { s, accepts, SettleError, VerifyError };
    })().catch(err => { ready = null; failedAt = now(); throw err; }));
  };
  let purgedAt = 0;
  // After the facilitator failed to answer a verify, new payments are not taken for RETRY_AFTER_MS,
  // rather than every paid call reaching an unavailable facilitator. (A lost settle answer is not
  // cooled down: the retry that recovers it should not have to wait.)
  let outageUntil = 0;
  const outage = () => { outageUntil = now() + RETRY_AFTER_MS; };

  const count = (outcome) => incCounter('chains_api_x402_payments_total', { outcome });

  // The PaymentRequired body comes from the library, which applies each scheme's additions; when
  // the facilitator was unreachable there is no library server, and nothing to accept.
  async function paymentRequired(c, error, fields = {}) {
    const resource = { url: `mcp://tool/${c.tool.name}`, description: c.tool.description ?? '', mimeType: 'application/json' };
    const message = alternative ? `${error}. ${alternative}` : error;
    const required = c.s ? await c.s.createPaymentRequiredResponse(c.accepts, resource, message) : { x402Version: 2, error: message, resource, accepts: [] };
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

  /**
   * The result with its payment's receipt. `rerun`: the tool ran again for this answer (a
   * recovered or redelivered call) — a fresh read of live data, not the result first produced,
   * which no caller received; the receipt is still that of the one payment.
   */
  function receipt(result, rec, settled = {}, { rerun = false } = {}) {
    const response = { success: true, transaction: rec.transaction, network: settled.network ?? rec.network, payer: settled.payer ?? rec.payer, ...(rerun ? { rerun: true } : {}) };
    return { ...result, _meta: { ...result?._meta, 'x402/payment-response': response } };
  }

  /**
   * Record a payment's new state. Once a settlement has happened, a ledger that cannot be written
   * must not cost the caller its result: the write is logged and the call answered. The record
   * then stays in flight, and a retry after the lease recovers it from the chain.
   */
  async function record(rec, fields) {
    try {
      if (!await ledger.transition(rec, fields)) logger.warn({ id: rec.id, to: fields.status }, 'x402 payment changed by another call meanwhile');
    } catch (err) {
      logger.warn({ err: err.message, id: rec.id, to: fields.status }, 'x402 payment ledger write failed');
    }
  }

  /** Settle the claimed payment (c.rec, in flight) for `result`, the tool's successful answer. */
  async function settle(c, result) {
    const { s, rec } = c;
    let outcome;
    try {
      outcome = settleOutcome(await s.settlePayment(c.payment, c.requirement), null, c.SettleError);
    } catch (err) {
      outcome = settleOutcome(null, err, c.SettleError);
    }
    // A recovery cannot take a refusal at its word: the earlier attempt may have paid before the
    // authorization expired or the payer's balance moved. Nor can anyone take "nonce spent". Only
    // the chain may rule our transfer out — the nonce spent elsewhere, or the authorization unusable
    // for good (x402Chain.js); until then the payment stays unresolved, and no new one is asked for.
    if (outcome.kind === 'nonce_used' || (c.recovering && outcome.kind !== 'settled')) {
      const seen = await observe({ network: rec.network, asset: rec.asset, payer: rec.payer, nonce: rec.nonce, payTo: rec.payTo, amount: rec.amount, validBefore: rec.validBefore, transaction: outcome.transaction ?? rec.transaction });
      if (seen.state === 'paid') outcome = { kind: 'settled', transaction: seen.transaction };
      else if (seen.state === 'other') outcome = { kind: 'refused', reason: 'its nonce was spent on another transfer' };
      else if (seen.state === 'expired_unused') outcome = { kind: 'refused', reason: 'it expired unused' };
      else outcome = { kind: 'unresolved', transaction: outcome.transaction ?? rec.transaction };
    }
    const at = now();
    if (outcome.kind === 'settled') {
      const settled = { ...rec, transaction: outcome.transaction ?? null };
      await record(rec, { status: 'settled', transaction: settled.transaction, updatedAt: at });
      count(c.recovering ? 'recovered' : 'settled');
      logger.info({ tool: c.tool.name, payer: outcome.payer ?? rec.payer, transaction: settled.transaction, network: outcome.network ?? rec.network, amount: rec.amount, asset: rec.asset, recovered: c.recovering }, 'x402 payment');
      return receipt(result, settled, outcome, { rerun: c.recovering });
    }
    if (outcome.kind === 'refused') {
      await record(rec, { status: 'refused', updatedAt: at });
      count('settlement_failed');
      return paymentRequired(c, `Settlement failed${outcome.reason ? `: ${outcome.reason}` : ''}`);
    }
    const unresolved = { ...rec, transaction: outcome.transaction ?? rec.transaction ?? null };
    await record(rec, { status: 'unresolved', transaction: unresolved.transaction, updatedAt: at });
    count('unresolved');
    logger.warn({ tool: c.tool.name, payer: rec.payer, nonce: rec.nonce, transaction: unresolved.transaction, network: rec.network }, 'x402 payment unresolved');
    return pending(unresolved, 'The payment\'s settlement could not be confirmed.');
  }

  /**
   * A payment the ledger already knows: in use, settled, refused, or to recover. A payment is
   * bound to the call it was first used for (tool and arguments): only that call is answered
   * again or recovered with it.
   */
  async function known(c, rec) {
    const sameCall = rec.tool === c.tool.name && rec.argsHash === c.argsHash;
    if (rec.status === 'settled') {
      // Its answer may have been lost on the way back: the same call, soon after, is answered again.
      if (sameCall && now() - rec.updatedAt < REDELIVER_MS) {
        count('redelivered');
        return receipt(await c.run(), rec, {}, { rerun: true });
      }
      count('invalid');
      return paymentRequired(c, 'Invalid payment: it has already been spent');
    }
    if (rec.status === 'refused') {
      count('invalid');
      return paymentRequired(c, 'Invalid payment: it was refused');
    }
    if (rec.status === 'in_flight' && now() - rec.updatedAt < IN_FLIGHT_LEASE_MS) {
      count('busy');
      return pending(rec, 'This payment is in use by another call.');
    }
    if (!sameCall) {
      // Unresolved for another call: left as it is, for that call to recover.
      count('other_call');
      return pending(rec, 'This payment is pending for a different call (another tool or other arguments); only that call can recover it.');
    }
    // unresolved, or in flight on a pod that never finished: take it over. As on a first attempt,
    // the tool runs first and only a successful answer is settled — the stopped pod may never have
    // produced one, and a failed call is not charged.
    const fields = { status: 'in_flight', updatedAt: now() };
    if (!await ledger.transition(rec, fields)) {
      count('busy');
      return pending(rec, 'This payment is in use by another call.');
    }
    const claimed = { ...rec, ...fields };
    const putBack = () => record(claimed, { status: 'unresolved', updatedAt: now() });
    let result;
    try {
      result = await c.run();
    } catch (err) {
      await putBack();
      throw err;
    }
    if (result?.isError) {
      await putBack();
      count('not_charged');
      return result;
    }
    return settle({ ...c, rec: claimed, recovering: true }, result);
  }

  /** A payment just claimed: verify it, run the tool, and settle. */
  async function first(c) {
    // Until it is settled, an unspent payment is released so that the caller may use it again.
    const release = () => ledger.release(c.rec).catch(() => {});
    let verified;
    try {
      verified = await c.s.verifyPayment(c.payment, c.requirement);
    } catch (err) {
      // A VerifyError is the facilitator rejecting this payment over HTTP: an invalid payment like
      // isValid: false, not an outage — one bad payment must not pause everyone else's.
      if (!(err instanceof c.VerifyError)) {
        await release();
        outage();
        logger.warn({ err: err.message, tool: c.tool.name }, 'x402 verification failed');
        count('unavailable');
        return paymentRequired(c, 'Payment could not be verified; try again');
      }
      verified = { isValid: false, invalidReason: err.invalidReason, payer: err.payer };
    }
    if (!verified.isValid) {
      await release();
      count('invalid');
      return paymentRequired(c, `Invalid payment: ${verified.invalidReason ?? 'rejected by the facilitator'}`, verified.payer ? { payer: verified.payer } : {});
    }

    let result;
    try {
      result = await c.run();
    } catch (err) {
      await release();
      throw err;
    }
    if (result?.isError) {
      await release();
      count('not_charged');
      return result;
    }
    return settle({ ...c, recovering: false }, result);
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
      const c = { tool, run, argsHash: sha256(canonical(args ?? {})) };
      try {
        Object.assign(c, await facilitator());
      } catch (err) {
        logger.warn({ err: err.message, tool: tool.name }, 'x402 facilitator unavailable');
        count('unavailable');
        return paymentRequired(c, 'Payment is temporarily unavailable');
      }
      if (!token) {
        count('required');
        return paymentRequired(c, 'Payment required');
      }
      c.payment = decodePayment(token);
      try {
        c.requirement = c.payment && c.s.findMatchingRequirements(c.accepts, c.payment);
      } catch {
        c.requirement = null; // an x402Version the library does not know
      }
      if (!c.requirement) {
        count('invalid');
        return paymentRequired(c, 'Invalid payment: it does not match what this tool accepts');
      }
      if (now() < outageUntil) {
        count('unavailable');
        return paymentRequired({ tool }, 'Payment is temporarily unavailable');
      }

      const authorization = c.payment.payload?.authorization ?? {};
      const t = now();
      c.rec = {
        id: paymentId(c.payment, c.requirement), status: 'in_flight', tool: tool.name, argsHash: c.argsHash,
        // The signed payload as a whole: its authorization's identity is public on-chain, its
        // signature is not until it settles, so only the payer can match a recorded payment.
        payloadHash: sha256(canonical(c.payment.payload ?? c.payment)),
        payer: authorization.from ?? null, nonce: authorization.nonce ?? null,
        network: c.requirement.network, asset: c.requirement.asset, amount: String(c.requirement.amount), payTo: c.requirement.payTo,
        validBefore: Number.isFinite(Number(authorization.validBefore)) ? Number(authorization.validBefore) : null,
        transaction: null, createdAt: t, updatedAt: t
      };
      if (t - purgedAt > PURGE_EVERY_MS) {
        purgedAt = t;
        ledger.purge(t - KEEP_MS).catch(err => logger.warn({ err: err.message }, 'x402 payment ledger purge failed'));
      }
      let claimed, existing;
      try {
        claimed = await ledger.claim(c.rec);
        existing = claimed ? null : await ledger.get(c.rec.id);
      } catch (err) {
        // Without the ledger a lost settlement could not be recovered, so no payment is taken.
        logger.warn({ err: err.message, tool: tool.name }, 'x402 payment ledger unavailable');
        count('unavailable');
        return paymentRequired({ tool }, 'Payment is temporarily unavailable');
      }
      if (claimed) return first(c);
      if (existing && existing.payloadHash !== c.rec.payloadHash) {
        // Same authorization, different payload: not the payer's. The record is left untouched.
        count('invalid');
        return paymentRequired(c, 'Invalid payment: it does not match the payment recorded for this authorization');
      }
      if (existing) return known(c, existing);
      // Claimed by another call and released again in between.
      count('busy');
      return pending(c.rec, 'This payment is in use by another call.');
    }
  };
}
