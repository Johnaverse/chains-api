import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('../../../rpcUtil.js', () => ({ jsonRpcCall: (url, method, { params } = {}) => rpc(url, method, params) }));

import { keccak256, toBytes, toFunctionSelector } from 'viem';
import { observeAuthorization, rpcUrlsFor } from '../../../src/auth/x402Chain.js';
import { cachedData } from '../../../src/store/cache.js';

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const ELSEWHERE = '0x1111111111111111111111111111111111111111';
const NONCE = `0x${'ab'.repeat(32)}`;
const AUTH_USED = keccak256(toBytes('AuthorizationUsed(address,bytes32)'));
const TRANSFER = keccak256(toBytes('Transfer(address,address,uint256)'));
const topic = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const hex = (n) => `0x${n.toString(16)}`;

// A chain with 2-second blocks, block n at time 2n. The authorization expires at block 5000.
const VALID_BEFORE = 10_000;
const P = { network: 'eip155:84532', asset: ASSET, payer: PAYER, nonce: NONCE, payTo: PAY_TO, amount: '1000', validBefore: VALID_BEFORE };
const TX = '0xabc';

/**
 * One RPC node's view of that chain. `transfer` is where the authorization was used: { block, to,
 * value, status } or none; the node knows blocks up to `head` and treats `head - lag` as
 * finalized. `fork` gives the node other block hashes (another chain, or a lying node).
 */
function node({ head = 9000, lag = 100, transfer = null, fork = '' } = {}) {
  const finalized = head - lag;
  const sees = (n) => transfer && transfer.block <= n;
  const block = (n) => (n > head ? null : { number: hex(n), hash: `0xh${fork}${n}`, timestamp: hex(2 * n) });
  const usedLog = { address: ASSET, topics: [AUTH_USED, topic(PAYER), NONCE], transactionHash: TX };
  const receipt = () => ({
    status: transfer.status ?? '0x1', blockNumber: hex(transfer.block),
    logs: [usedLog, { address: ASSET, topics: [TRANSFER, topic(PAYER), topic(transfer.to ?? PAY_TO)], data: `0x${(transfer.value ?? 1000).toString(16).padStart(64, '0')}` }]
  });
  return async (method, params) => {
    switch (method) {
      case 'eth_blockNumber': return hex(head);
      case 'eth_getBlockByNumber': return block(params[0] === 'finalized' ? finalized : Number(params[0]));
      case 'eth_call': {
        const at = params[1] === 'latest' ? head : Number(params[1]);
        return `0x${(sees(at) ? 1 : 0).toString(16).padStart(64, '0')}`;
      }
      case 'eth_getTransactionReceipt': return params[0] === TX && sees(head) ? receipt() : null;
      case 'eth_getLogs': {
        const { fromBlock, toBlock } = params[0];
        return sees(head) && Number(fromBlock) <= transfer.block && transfer.block <= Number(toBlock) ? [usedLog] : [];
      }
      default: throw new Error(`unexpected ${method}`);
    }
  };
}
/** Endpoints by URL: each a node, or 'down'. */
function network(...nodes) {
  const byUrl = Object.fromEntries(nodes.map((n, i) => [`https://rpc${i}.test`, n]));
  rpc.mockImplementation(async (url, method, params) => {
    const n = byUrl[url];
    if (!n || n === 'down') throw new Error('timeout');
    return n(method, params);
  });
  return Object.keys(byUrl);
}
const observe = (nodes, extra = {}) => observeAuthorization({ ...P, ...extra }, { urls: network(...nodes) });

beforeEach(() => { rpc.mockReset(); });

describe('observeAuthorization', () => {
  it('uses the protocol signatures', async () => {
    await observe([node({ transfer: { block: 4000 } }), node({ transfer: { block: 4000 } })]);
    const call = rpc.mock.calls.find(c => c[1] === 'eth_call')[2][0];
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector('authorizationState(address,bytes32)'));
    const getLogs = rpc.mock.calls.find(c => c[1] === 'eth_getLogs')[2][0];
    expect(getLogs.topics).toEqual([AUTH_USED, topic(PAYER), NONCE]);
  });

  it('sees a payment to us when two endpoints find the same transaction', async () => {
    expect(await observe([node({ transfer: { block: 6000 } }), node({ transfer: { block: 6000 } }), node()])).toEqual({ state: 'paid', transaction: TX });
  });

  describe('a pending settlement that went through, past the authorization\'s expiry', () => {
    const paidAt = { block: 4990 };

    it('is not refused when only one endpoint has its receipt and two lag', async () => {
      // The lagging nodes say "unspent at latest", but their heads predate the transfer.
      const res = await observe([node({ head: 4980, lag: 0 }), node({ head: 4985, lag: 0 }), node({ head: 9000, transfer: paidAt })], { transaction: TX });
      expect(res).toEqual({ state: 'unknown' });
    });

    it('is not refused when every endpoint lags', async () => {
      const res = await observe([node({ head: 4980, lag: 0 }), node({ head: 4985, lag: 0 }), node({ head: 4970, lag: 0 })], { transaction: TX });
      expect(res).toEqual({ state: 'unknown' });
    });

    it('is recovered when two endpoints show it', async () => {
      const res = await observe([node({ head: 4980, lag: 0 }), node({ transfer: paidAt }), node({ transfer: paidAt })], { transaction: TX });
      expect(res).toEqual({ state: 'paid', transaction: TX });
      expect(rpc.mock.calls.some(c => c[1] === 'eth_getLogs')).toBe(false);
    });

    it('stays unknown when no endpoint answers', async () => {
      expect(await observe(['down', 'down', 'down'], { transaction: TX })).toEqual({ state: 'unknown' });
    });
  });

  describe('an authorization never used', () => {
    it('is expired_unused once two endpoints agree on a finalized block past its expiry, unspent there', async () => {
      expect(await observe([node(), node({ head: 8000 }), 'down'])).toEqual({ state: 'expired_unused' });
      // Checked at the lower finalized head of the two (7900), the same block on both.
      const at = rpc.mock.calls.filter(c => c[1] === 'eth_call' && c[2][1] !== 'latest').map(c => c[2][1]);
      expect(at).toEqual([hex(7900), hex(7900)]);
    });

    it('stays unknown while the agreed finalized block is not past its expiry', async () => {
      expect(await observe([node({ head: 5050, lag: 100 }), node({ head: 9000 })])).toEqual({ state: 'unknown' });
    });

    it('stays unknown on one endpoint, or two that disagree on the finalized block', async () => {
      expect(await observe([node(), 'down'])).toEqual({ state: 'unknown' });
      expect(await observe([node(), node({ fork: 'x' })])).toEqual({ state: 'unknown' });
      expect(await observe([node(), node({ fork: 'x' }), node()])).toEqual({ state: 'expired_unused' });
    });

    it('stays unknown when the endpoints cannot name a finalized block', async () => {
      const noFinality = (n) => async (method, params) => (method === 'eth_getBlockByNumber' && params[0] === 'finalized' ? Promise.reject(new Error('unsupported')) : n(method, params));
      expect(await observe([noFinality(node()), noFinality(node())])).toEqual({ state: 'unknown' });
    });

    it('is not taken for unused while any endpoint shows it used', async () => {
      expect(await observe([node(), node(), node({ transfer: { block: 4000 } })])).toEqual({ state: 'unknown' });
    });
  });

  describe('a nonce spent on a transfer that did not pay us', () => {
    it.each([
      ['to someone else', { to: ELSEWHERE }],
      ['for less', { value: 999 }],
      ['in a failed transaction', { status: '0x0' }]
    ])('is other when two endpoints show it %s in a finalized block', async (_label, t) => {
      const transfer = { block: 6000, ...t };
      expect(await observe([node({ transfer }), node({ transfer })])).toEqual({ state: 'other' });
    });

    it('stays unknown while that transfer is not final, or only one endpoint shows it', async () => {
      const transfer = { block: 8950, to: ELSEWHERE };
      expect(await observe([node({ transfer }), node({ transfer })])).toEqual({ state: 'unknown' });
      expect(await observe([node({ transfer: { block: 6000, to: ELSEWHERE } }), node({ head: 5000, lag: 0 })])).toEqual({ state: 'unknown' });
    });
  });

  it('searches back in ranges of at most 1000 blocks, over 5000', async () => {
    const transfer = { block: 9000 - 3500 };
    const urls = network(node({ transfer }), node({ transfer }));
    expect(await observeAuthorization(P, { urls })).toEqual({ state: 'paid', transaction: TX });
    const ranges = rpc.mock.calls.filter(c => c[0] === urls[0] && c[1] === 'eth_getLogs').map(c => Number(c[2][0].toBlock) - Number(c[2][0].fromBlock) + 1);
    expect(ranges).toEqual([1000, 1000, 1000, 1000]);
    // Spent longer ago than the window: unknown, and never unused.
    expect(await observe([node({ transfer: { block: 1000 } }), node({ transfer: { block: 1000 } })])).toEqual({ state: 'unknown' });
  });

  it('answers unknown, not another transfer, when a found transaction\'s receipt is missing', async () => {
    const transfer = { block: 4000 };
    const noReceipt = (n) => async (method, params) => (method === 'eth_getTransactionReceipt' ? null : n(method, params));
    expect(await observe([noReceipt(node({ transfer })), noReceipt(node({ transfer }))])).toEqual({ state: 'unknown' });
  });

  it('answers unknown for what it cannot check', async () => {
    const urls = network(node(), node());
    expect(await observeAuthorization({ ...P, nonce: null }, { urls })).toEqual({ state: 'unknown' });
    expect(await observeAuthorization({ ...P, network: 'solana:mainnet' }, { urls })).toEqual({ state: 'unknown' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads the chain\'s healthy endpoints from the registry, fastest first', () => {
    const saved = cachedData.rpcHealth;
    cachedData.rpcHealth = { 84532: [
      { url: 'https://slow.test', ok: true, latencyMs: 900 },
      { url: 'https://dead.test', ok: false, latencyMs: 10 },
      { url: 'wss://socket.test', ok: true, latencyMs: 5 },
      { url: 'https://fast.test', ok: true, latencyMs: 50 }
    ] };
    try {
      expect(rpcUrlsFor(84532)).toEqual(['https://fast.test', 'https://slow.test']);
      expect(rpcUrlsFor(1)).toEqual([]);
    } finally {
      cachedData.rpcHealth = saved;
    }
  });
});
