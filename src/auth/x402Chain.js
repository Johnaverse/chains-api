import { jsonRpcCall } from '../../rpcUtil.js';
import { cachedData } from '../store/cache.js';
import { logger } from '../util/logger.js';

/**
 * Whether an EIP-3009 authorization (an x402 `exact` EVM payment) was used on-chain, and whether
 * it paid us: read from the token contract through the chain's own healthy RPC endpoints, as
 * this registry measures them. Used when a settlement's outcome was lost, so that recovery sees
 * what the first attempt did instead of asking for another payment.
 *
 * Answers one of:
 *   { state: 'paid', transaction }  the authorization moved at least `amount` from payer to payTo
 *   { state: 'other' }              its nonce was spent on a transfer that did not pay us
 *   { state: 'unused' }             its nonce is still unspent
 *   { state: 'unknown' }            no endpoint answered, or the use is older than the log window
 */
// Event and function signatures of EIP-3009 / ERC-20 (keccak-256 of the canonical signatures).
const AUTHORIZATION_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'; // AuthorizationUsed(address,bytes32)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const AUTHORIZATION_STATE = '0xe94a0102'; // authorizationState(address,bytes32)
// How far back to look for the authorization's use. Payments are reconciled within minutes of the
// attempt; this covers well over an hour on the fastest supported chains.
const LOG_WINDOW_BLOCKS = 5000;
const MAX_ENDPOINTS = 3;
const RPC_TIMEOUT_MS = 8000;

const word = (hex) => `0x${hex.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const sameAddress = (topic, address) => BigInt(topic) === BigInt(address);

/** Healthy http(s) RPC endpoints of a chain, fastest first. */
export function rpcUrlsFor(chainId) {
  const results = cachedData.rpcHealth?.[chainId] ?? cachedData.rpcHealth?.[String(chainId)] ?? [];
  return results
    .filter(r => r.ok && /^https?:\/\//.test(r.url ?? ''))
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .slice(0, MAX_ENDPOINTS)
    .map(r => r.url);
}

async function readAt(url, { asset, payer, nonce, payTo, amount }) {
  const call = (method, params) => jsonRpcCall(url, method, { params, timeoutMs: RPC_TIMEOUT_MS });
  const latest = Number.parseInt(await call('eth_blockNumber', []), 16);
  const logs = await call('eth_getLogs', [{
    address: asset,
    topics: [AUTHORIZATION_USED, word(payer), word(nonce)],
    fromBlock: `0x${Math.max(0, latest - LOG_WINDOW_BLOCKS).toString(16)}`,
    toBlock: 'latest'
  }]);
  if (!logs.length) {
    const used = await call('eth_call', [{ to: asset, data: `${AUTHORIZATION_STATE}${word(payer).slice(2)}${word(nonce).slice(2)}` }, 'latest']);
    return BigInt(used) === 0n ? { state: 'unused' } : { state: 'unknown' };
  }
  const transaction = logs[0].transactionHash;
  const receipt = await call('eth_getTransactionReceipt', [transaction]);
  const paid = (receipt?.logs ?? []).some(l => String(l.address).toLowerCase() === asset.toLowerCase()
    && l.topics?.[0] === TRANSFER && sameAddress(l.topics[1], payer) && sameAddress(l.topics[2], payTo)
    && BigInt(l.data) >= BigInt(amount));
  return paid && receipt.status === '0x1' ? { state: 'paid', transaction } : { state: 'other' };
}

/**
 * @param {object} p
 * @param {string} p.network  CAIP-2, eip155:<chainId>
 * @param {string} p.asset    token contract
 * @param {string} p.payer    authorizer (`authorization.from`)
 * @param {string} p.nonce    `authorization.nonce` (bytes32)
 * @param {string} p.payTo
 * @param {string} p.amount   atomic units
 */
export async function observeAuthorization(p, { urls = rpcUrlsFor(Number(String(p.network).split(':')[1])) } = {}) {
  if (!/^eip155:\d+$/.test(p.network) || !p.payer || !p.nonce) return { state: 'unknown' };
  for (const url of urls) {
    try {
      return await readAt(url, p);
    } catch (err) {
      logger.debug({ err: err.message, network: p.network }, 'x402 on-chain check failed on one endpoint');
    }
  }
  return { state: 'unknown' };
}
