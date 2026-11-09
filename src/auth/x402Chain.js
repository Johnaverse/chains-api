import { jsonRpcCall } from '../../rpcUtil.js';
import { cachedData } from '../store/cache.js';
import { logger } from '../util/logger.js';

/**
 * What became of an EIP-3009 authorization (an x402 `exact` EVM payment) on-chain, read from the
 * token contract through the chain's own healthy RPC endpoints, as this registry measures them.
 * Used when a settlement's outcome was lost, so that recovery sees what the first attempt did
 * instead of asking for another payment.
 *
 * Answers one of:
 *   { state: 'paid', transaction }  the authorization moved at least `amount` from payer to payTo
 *   { state: 'other' }              its nonce was spent, in a finalized block, on a transfer that
 *                                   did not pay us
 *   { state: 'expired_unused' }     it can never be used: unspent at a finalized block whose time
 *                                   is past its `validBefore`
 *   { state: 'unknown' }            anything less certain
 *
 * The endpoints are public and may lag, so the answers that would let a caller be asked to pay
 * again need proof that no node can give alone:
 *  - 'paid' and 'other' need two endpoints that agree on the same transaction;
 *  - 'expired_unused' needs two endpoints that have both finalized the same block (number and
 *    hash), past the authorization's expiry, with the nonce unspent at that block — not "unspent
 *    at latest", which a lagging node says of a transfer it has not seen yet;
 *  - a transfer counts for one authorization only: in a transaction that uses several of the
 *    payer's, each is matched to its own transfer, or the answer is unknown;
 *  - any sign that the authorization was used (a receipt, a spent nonce, a log) on any endpoint
 *    rules both refusals out.
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
const num = (hex) => Number.parseInt(hex, 16);

/** Healthy http(s) RPC endpoints of a chain, fastest first. */
export function rpcUrlsFor(chainId) {
  const results = cachedData.rpcHealth?.[chainId] ?? cachedData.rpcHealth?.[String(chainId)] ?? [];
  return results
    .filter(r => r.ok && /^https?:\/\//.test(r.url ?? ''))
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity))
    .slice(0, ENDPOINTS)
    .map(r => r.url);
}

function reader(url, { asset, payer, nonce }) {
  const call = (method, params) => jsonRpcCall(url, method, { params, timeoutMs: RPC_TIMEOUT_MS });
  return {
    call,
    spentAt: async (block) => BigInt(await call('eth_call', [{ to: asset, data: `${AUTHORIZATION_STATE}${word(payer).slice(2)}${word(nonce).slice(2)}` }, block])) !== 0n,
    usedIn: (log) => String(log.address).toLowerCase() === asset.toLowerCase()
      && log.topics?.[0] === AUTHORIZATION_USED && sameAddress(log.topics[1], payer) && BigInt(log.topics[2]) === BigInt(nonce)
  };
}

/**
 * What one endpoint shows of the authorization's use: { use, finalized }. `use` is null (no sign
 * of use), { spent: true } (spent, transaction not found), or { state: 'paid' | 'other',
 * transaction, blockNumber }. `finalized` is its finalized head, or null. Throws when the endpoint
 * cannot answer.
 */
async function useAt(url, p) {
  const { call, spentAt, usedIn } = reader(url, p);
  const judge = (hash, receipt) => {
    // A missing receipt (a reorg, a lagging backend) says nothing about where the funds went.
    if (!receipt) return { spent: true };
    const logs = receipt.logs ?? [];
    const ofAsset = (l) => String(l?.address).toLowerCase() === p.asset.toLowerCase();
    const payersTransfer = (l) => ofAsset(l) && l.topics?.[0] === TRANSFER && sameAddress(l.topics[1], p.payer);
    // Which transfer is this authorization's? With one authorization of the payer in the
    // transaction, any transfer of theirs in it. With several (a batch), one transfer must not be
    // credited to each: the token emits an authorization's Transfer right after its
    // AuthorizationUsed, so each is read with the log that follows it, and a batch that does not
    // read that way throughout is left undecided.
    const mine = logs.findIndex(usedIn);
    const used = logs.flatMap((l, i) => (ofAsset(l) && l.topics?.[0] === AUTHORIZATION_USED && sameAddress(l.topics[1], p.payer) ? [i] : []));
    if (mine < 0 || (used.length > 1 && !used.every(i => payersTransfer(logs[i + 1])))) return { spent: true };
    const transfers = used.length > 1 ? [logs[mine + 1]] : logs.filter(payersTransfer);
    const paid = receipt.status === '0x1' && transfers.some(l => sameAddress(l.topics[2], p.payTo)
      && /^0x[0-9a-f]+$/i.test(l.data) && BigInt(l.data) >= BigInt(p.amount));
    // A receipt without a block number cannot be shown final (NaN compares false).
    return { state: paid ? 'paid' : 'other', transaction: hash, blockNumber: num(receipt.blockNumber) };
  };
  const finalized = await call('eth_getBlockByNumber', ['finalized', false]).catch(() => null);

  // A known transaction (a pending settlement) is read before any state, so that a node which
  // has its receipt is heard even when its state, or another node's, has not caught up.
  if (p.transaction) {
    const receipt = await call('eth_getTransactionReceipt', [p.transaction]);
    if (receipt?.logs?.some(usedIn)) return { use: judge(p.transaction, receipt), finalized };
  }
  if (!await spentAt('latest')) return { use: null, finalized };
  const latest = num(await call('eth_blockNumber', []));
  for (let to = latest; to > latest - LOG_WINDOW_BLOCKS && to >= 0; to -= LOG_CHUNK_BLOCKS) {
    const from = Math.max(0, to - LOG_CHUNK_BLOCKS + 1);
    const logs = await call('eth_getLogs', [{ address: p.asset, topics: [AUTHORIZATION_USED, word(p.payer), word(p.nonce)], fromBlock: hexBlock(from), toBlock: hexBlock(to) }]);
    if (logs.length) {
      const hash = logs[0].transactionHash;
      return { use: judge(hash, await call('eth_getTransactionReceipt', [hash])), finalized };
    }
  }
  return { use: { spent: true }, finalized }; // spent, longer ago than the window
}

/**
 * Whether two endpoints agree that the authorization is unspent at one finalized block past its
 * expiry: the highest block that two of them have finalized, which each must show with the same
 * hash. `finalized` holds each endpoint's finalized head. Only endpoints that have finalized that
 * block take part: one that names no finalized head, or an earlier one, could confirm a block on
 * a branch that is not final.
 */
async function expiredUnused(urls, finalized, p) {
  const heads = finalized.map(f => (f ? num(f.number) : Number.NaN));
  const at = heads.filter(Number.isFinite).sort((a, b) => b - a)[AGREEMENT - 1];
  if (at === undefined || !p.validBefore) return false;
  const views = await Promise.all(urls.filter((_, i) => heads[i] >= at).map(async (url) => {
    try {
      const { call, spentAt } = reader(url, p);
      const block = await call('eth_getBlockByNumber', [hexBlock(at), false]);
      if (!block?.hash || num(block.timestamp) <= p.validBefore) return null;
      return (await spentAt(hexBlock(at))) ? null : block.hash;
    } catch {
      return null;
    }
  }));
  const byHash = new Map();
  for (const h of views.filter(Boolean)) byHash.set(h, (byHash.get(h) ?? 0) + 1);
  return [...byHash.values()].some(n => n >= AGREEMENT);
}

/**
 * @param {object} p
 * @param {string} p.network        CAIP-2, eip155:<chainId>
 * @param {string} p.asset          token contract
 * @param {string} p.payer          authorizer (`authorization.from`)
 * @param {string} p.nonce          `authorization.nonce` (bytes32)
 * @param {string} p.payTo
 * @param {string} p.amount         atomic units
 * @param {number} [p.validBefore]  `authorization.validBefore` (unix seconds)
 * @param {string} [p.transaction]  the settlement's transaction, when the facilitator gave one
 */
export async function observeAuthorization(p, { urls = rpcUrlsFor(Number(String(p.network).split(':')[1])) } = {}) {
  if (!/^eip155:\d+$/.test(p.network) || !p.payer || !p.nonce) return { state: 'unknown' };
  const asked = urls.slice(0, ENDPOINTS);
  const answers = await Promise.all(asked.map(url => useAt(url, p).catch(err => {
    logger.debug({ err: err.message, network: p.network }, 'x402 on-chain check failed on one endpoint');
    return null;
  })));
  const seen = answers.filter(Boolean);

  const agreeOn = (state) => {
    const votes = new Map();
    for (const a of seen) if (a.use?.state === state) votes.set(a.use.transaction, [...(votes.get(a.use.transaction) ?? []), a]);
    return [...votes.entries()].find(([, v]) => v.length >= AGREEMENT);
  };
  const paid = agreeOn('paid');
  if (paid) return { state: 'paid', transaction: paid[0] };
  // Any sign of use — paid, spent, or a transfer elsewhere not yet agreed — rules out both refusals
  // below, except 'other' itself when two endpoints show it final and none shows it paid us.
  if (seen.some(a => a.use?.state === 'paid' || a.use?.spent)) return { state: 'unknown' };
  const other = agreeOn('other');
  if (other) {
    const final = other[1].filter(a => a.finalized && num(a.finalized.number) >= a.use.blockNumber);
    return final.length >= AGREEMENT ? { state: 'other' } : { state: 'unknown' };
  }
  if (seen.some(a => a.use)) return { state: 'unknown' };
  const unusedHere = asked.filter((_, i) => answers[i] && !answers[i].use);
  const heads = unusedHere.map(url => answers[asked.indexOf(url)].finalized);
  return (await expiredUnused(unusedHere, heads, p)) ? { state: 'expired_unused' } : { state: 'unknown' };
}
