import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';

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
 * The facilitator holds no funds and needs no key here; it only checks signatures and submits the
 * transfer. The asset (USDC on the configured network) and its amount come from @x402/evm.
 */
const SCHEME = 'exact';
const MAX_TIMEOUT_SECONDS = 300;
// After the facilitator could not be reached (or does not serve the network), calls are answered
// "temporarily unavailable" for this long before it is asked again, rather than once per call.
const RETRY_AFTER_MS = 30_000;

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
 * @param {object} cfg
 * @param {string} cfg.payTo           wallet that receives payments
 * @param {string} cfg.network         CAIP-2 network id
 * @param {number} cfg.priceUsd        price of one tool call
 * @param {string} cfg.facilitatorUrl  x402 facilitator (verify + settle)
 * @param {string[]} [cfg.domains]    hosts whose requests are charged; empty charges every request
 * @param {string} [cfg.alternative]   how to use the tools without paying, told to a client that hasn't paid
 * @param {object} [cfg.resourceServer] an x402ResourceServer stand-in (tests)
 * @param {() => number} [cfg.now]
 */
export function x402Paywall({ payTo, network, priceUsd, facilitatorUrl, domains = [], alternative = '', resourceServer = null, now = Date.now }) {
  // The facilitator's supported kinds are read once; a failure is retried after RETRY_AFTER_MS.
  let ready = null;
  let failedAt = -Infinity;
  const server = () => {
    if (!ready && now() - failedAt < RETRY_AFTER_MS) return Promise.reject(new Error('facilitator unavailable; retrying later'));
    return (ready ??= (async () => {
      const s = resourceServer ?? await facilitatorServer(facilitatorUrl);
      await s.initialize();
      const accepts = await s.buildPaymentRequirements({ scheme: SCHEME, payTo, price: priceUsd, network, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS });
      return { s, accepts };
    })().catch(err => { ready = null; failedAt = now(); throw err; }));
  };
  // Payments being verified, run or settled. Verifying does not spend a payment, so the same one
  // sent on concurrent calls would otherwise run the tool once per call for a single settlement.
  const inFlight = new Set();

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

  /** Verify, run, then settle one payment (call() holds it in flight meanwhile). */
  async function verifyRunSettle(s, tool, accepts, payment, requirement, run) {
    try {
      const verified = await s.verifyPayment(payment, requirement);
      if (!verified.isValid) {
        count('invalid');
        return paymentRequired(s, tool, accepts, `Invalid payment: ${verified.invalidReason ?? 'rejected by the facilitator'}`, verified.payer ? { payer: verified.payer } : {});
      }
    } catch (err) {
      logger.warn({ err: err.message, tool: tool.name }, 'x402 verification failed');
      count('unavailable');
      return paymentRequired(s, tool, accepts, 'Payment could not be verified; try again');
    }

    const result = await run();
    if (result?.isError) {
      count('not_charged');
      return result;
    }
    let settled;
    try {
      settled = await s.settlePayment(payment, requirement);
    } catch (err) {
      logger.warn({ err: err.message, tool: tool.name }, 'x402 settlement failed');
      settled = { success: false };
    }
    if (!settled.success) {
      count('settlement_failed');
      return paymentRequired(s, tool, accepts, `Settlement failed${settled.errorReason ? `: ${settled.errorReason}` : ''}`);
    }
    count('settled');
    logger.info({ tool: tool.name, payer: settled.payer, transaction: settled.transaction, network: settled.network, amount: requirement.amount, asset: requirement.asset }, 'x402 payment');
    return {
      ...result,
      _meta: { ...result?._meta, 'x402/payment-response': { success: true, transaction: settled.transaction, network: settled.network, payer: settled.payer } }
    };
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
     * Run one paid tool call. `tool` is { name, description }; `run` produces the tool result.
     * Returns the result, or the PaymentRequired result when it was not (or could not be) paid.
     */
    async call(tool, token, run) {
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
      const id = JSON.stringify(payment.payload ?? payment);
      if (inFlight.has(id)) {
        count('invalid');
        return paymentRequired(s, tool, accepts, 'Invalid payment: it is already being used by another call');
      }
      inFlight.add(id);
      try {
        return await verifyRunSettle(s, tool, accepts, payment, requirement, run);
      } finally {
        inFlight.delete(id);
      }
    }
  };
}
