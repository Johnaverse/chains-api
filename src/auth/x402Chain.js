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
 *   { state: 'unknown' }            fewer than two endpoints agreed, or the use was not found
 *
 * The endpoints are public, so no single one is believed: a definitive answer needs two that
 * agree (for 'paid', on the same transaction). Anything less is 'unknown', which keeps the
 * payment unresolved rather than serving it, or refusing it, on one node's word.
 */
// Event and function signatures of EIP-3009 / ERC-20 (keccak-256 of the canonical signatures).
const AUTHORIZATION_USED = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'; // AuthorizationUsed(address,bytes32)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)
const AUTHORIZATION_STATE = '0xe94a0102'; // authorizationState(address,bytes32)
// Where to look for the use when its transaction is not known: back from the latest block, in
// ranges small enough for public endpoints that cap eth_getLogs. Payments are reconciled within
// minutes; this covers well over an hour on the fastest supported chains.
const LOG_CHUNK_BLOCKS = 1000;
const LOG_WINDOW_BLOCKS = 5000;
const ENDPOINTS = 3;
const AGREEMENT = 2;
const RPC_TIMEOUT_MS = 8000;

const word = (hex) => `0x${hex.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const sameAddress = (topic, address) => BigInt(topic) === BigInt(address);
const hexBlock = (n) => `0x${n.toString(16)}`;

/** Healthy http(s) RPC endpoints of a chain, fastest first. */
export function rpcUrlsFor(chainId) {
  const results = cachedData.rpcHealth?.[chainId] ?? cachedData.rpcHealth?.[String(chainId)] ?? [];
  return results
    .filter(r => r.ok && /^https?:\/\//.test(r.url ?? ''))
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .slice(0, ENDPOINTS)
    .map(r => r.url);
}

/** One endpoint's answer. Throws when the endpoint cannot answer. */
async function readAt(url, { asset, payer, nonce, payTo, amount, transaction }) {
  const call = (method, params) => jsonRpcCall(url, method, { params, timeoutMs: RPC_TIMEOUT_MS });
  const used = await call('eth_call', [{ to: asset, data: `${AUTHORIZATION_STATE}${word(payer).slice(2)}${word(nonce).slice(2)}` }, 'latest']);
  if (BigInt(used) === 0n) return { state: 'unused' };

  const usedHere = (log) => String(log.address).toLowerCase() === asset.toLowerCase()
    && log.topics?.[0] === AUTHORIZATION_USED && sameAddress(log.topics[1], payer) && BigInt(log.topics[2]) === BigInt(nonce);
  const judge = (hash, receipt) => {
    const paid = receipt?.status === '0x1' && (receipt.logs ?? []).some(l => String(l.address).toLowerCase() === asset.toLowerCase()
      && l.topics?.[0] === TRANSFER && sameAddress(l.topics[1], payer) && sameAddress(l.topics[2], payTo)
      && /^0x[0-9a-f]+$/i.test(l.data) && BigInt(l.data) >= BigInt(amount));
    return paid ? { state: 'paid', transaction: hash } : { state: 'other' };
  };

  // The transaction is known (a pending settlement): its receipt answers directly.
  if (transaction) {
    const receipt = await call('eth_getTransactionReceipt', [transaction]);
    if (receipt?.logs?.some(usedHere)) return judge(transaction, receipt);
  }
  const latest = Number.parseInt(await call('eth_blockNumber', []), 16);
  for (let to = latest; to > latest - LOG_WINDOW_BLOCKS && to >= 0; to -= LOG_CHUNK_BLOCKS) {
    const from = Math.max(0, to - LOG_CHUNK_BLOCKS + 1);
    const logs = await call('eth_getLogs', [{ address: asset, topics: [AUTHORIZATION_USED, word(payer), word(nonce)], fromBlock: hexBlock(from), toBlock: hexBlock(to) }]);
    if (logs.length) {
      const hash = logs[0].transactionHash;
      return judge(hash, await call('eth_getTransactionReceipt', [hash]));
    }
  }
  return { state: 'unknown' }; // spent, but longer ago than the window
}

/**
 * @param {object} p
 * @param {string} p.network        CAIP-2, eip155:<chainId>
 * @param {string} p.asset          token contract
 * @param {string} p.payer          authorizer (`authorization.from`)
 * @param {string} p.nonce          `authorization.nonce` (bytes32)
 * @param {string} p.payTo
 * @param {string} p.amount         atomic units
 * @param {string} [p.transaction]  the settlement's transaction, when the facilitator gave one
 */
export async function observeAuthorization(p, { urls = rpcUrlsFor(Number(String(p.network).split(':')[1])) } = {}) {
  if (!/^eip155:\d+$/.test(p.network) || !p.payer || !p.nonce) return { state: 'unknown' };
  const answers = await Promise.all(urls.slice(0, ENDPOINTS).map(url => readAt(url, p).catch(err => {
    logger.debug({ err: err.message, network: p.network }, 'x402 on-chain check failed on one endpoint');
    return null;
  })));
  const votes = new Map();
  for (const a of answers) {
    if (!a || a.state === 'unknown') continue;
    const key = `${a.state}:${a.transaction ?? ''}`;
    votes.set(key, { answer: a, n: (votes.get(key)?.n ?? 0) + 1 });
  }
  const agreed = [...votes.values()].find(v => v.n >= AGREEMENT);
  return agreed ? agreed.answer : { state: 'unknown' };
}
