import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('../../../rpcUtil.js', () => ({ jsonRpcCall: (url, method, { params } = {}) => rpc(url, method, params) }));

import { keccak256, toBytes, toFunctionSelector } from 'viem';
import { observeAuthorization, rpcUrlsFor } from '../../../src/auth/x402Chain.js';
import { cachedData } from '../../../src/store/cache.js';

const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
const PAY_TO = '0x000000000000000000000000000000000000dEaD';
const NONCE = `0x${'ab'.repeat(32)}`;
const P = { network: 'eip155:84532', asset: ASSET, payer: PAYER, nonce: NONCE, payTo: PAY_TO, amount: '1000' };
const AUTH_USED = keccak256(toBytes('AuthorizationUsed(address,bytes32)'));
const TRANSFER = keccak256(toBytes('Transfer(address,address,uint256)'));
const topic = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
const transfer = (to, value, address = ASSET) => ({ address, topics: [TRANSFER, topic(PAYER), topic(to)], data: `0x${value.toString(16).padStart(64, '0')}` });

/**
 * A node whose chain shows the authorization used (`used`) in tx 0xabc, `blocksAgo` blocks before
 * the latest (10000), with `logs` in its receipt — or not used at all. `lie` turns it into a node
 * that answers paid for anything.
 */
function node({ used = false, logs = [], blocksAgo = 10, status = '0x1', lie = false } = {}) {
  const usedLog = { address: ASSET, topics: [AUTH_USED, topic(PAYER), NONCE], transactionHash: '0xabc' };
  return vi.fn(async (method, params) => {
    if (method === 'eth_call') return `0x${(used || lie ? 1 : 0).toString(16).padStart(64, '0')}`;
    if (method === 'eth_blockNumber') return '0x2710';
    if (method === 'eth_getLogs') {
      const { fromBlock, toBlock } = params[0];
      const at = 10000 - blocksAgo;
      return (used && Number(fromBlock) <= at && at <= Number(toBlock)) || lie ? [usedLog] : [];
    }
    if (method === 'eth_getTransactionReceipt') {
      if (lie) return { status: '0x1', logs: [usedLog, transfer(PAY_TO, 1000)] };
      return used && params[0] === '0xabc' ? { status, logs: [usedLog, ...logs] } : null;
    }
    throw new Error(`unexpected ${method}`);
  });
}
/** Endpoints by URL: each a node, or 'down'. */
function network(nodes) {
  rpc.mockImplementation(async (url, method, params) => {
    const n = nodes[url];
    if (!n || n === 'down') throw new Error('timeout');
    return n(method, params);
  });
  return Object.keys(nodes);
}
const twice = (opts) => network({ 'https://a.test': node(opts), 'https://b.test': node(opts) });

beforeEach(() => { rpc.mockReset(); });

describe('observeAuthorization', () => {
  it('uses the protocol signatures, reading authorizationState first', async () => {
    const urls = twice({ used: false });
    expect(await observeAuthorization(P, { urls })).toEqual({ state: 'unused' });
    const [, method, params] = rpc.mock.calls[0];
    expect(method).toBe('eth_call');
    expect(params[0].data.slice(0, 10)).toBe(toFunctionSelector('authorizationState(address,bytes32)'));
    expect(rpc.mock.calls.every(c => c[1] === 'eth_call')).toBe(true);
  });

  it('sees a payment to us in the transaction that used the authorization', async () => {
    const urls = twice({ used: true, logs: [transfer(PAY_TO, 1000)] });
    expect(await observeAuthorization(P, { urls })).toEqual({ state: 'paid', transaction: '0xabc' });
    const getLogs = rpc.mock.calls.find(c => c[1] === 'eth_getLogs')[2][0];
    expect(getLogs.topics).toEqual([AUTH_USED, topic(PAYER), NONCE]);
  });

  it('searches back in ranges of at most 1000 blocks, over 5000', async () => {
    const urls = twice({ used: true, logs: [transfer(PAY_TO, 1000)], blocksAgo: 3500 });
    expect(await observeAuthorization(P, { urls })).toEqual({ state: 'paid', transaction: '0xabc' });
    const ranges = rpc.mock.calls.filter(c => c[0] === urls[0] && c[1] === 'eth_getLogs').map(c => Number(c[2][0].toBlock) - Number(c[2][0].fromBlock) + 1);
    expect(ranges).toEqual([1000, 1000, 1000, 1000]);
    rpc.mockClear();
    twice({ used: true, logs: [transfer(PAY_TO, 1000)], blocksAgo: 6000 });
    expect(await observeAuthorization(P, { urls })).toEqual({ state: 'unknown' });
    expect(rpc.mock.calls.filter(c => c[0] === urls[0] && c[1] === 'eth_getLogs')).toHaveLength(5);
  });

  it('reads a known transaction directly, without searching logs', async () => {
    const urls = twice({ used: true, logs: [transfer(PAY_TO, 1000)], blocksAgo: 9000 });
    expect(await observeAuthorization({ ...P, transaction: '0xabc' }, { urls })).toEqual({ state: 'paid', transaction: '0xabc' });
    expect(rpc.mock.calls.some(c => c[1] === 'eth_getLogs')).toBe(false);
  });

  it.each([
    ['to someone else', [transfer('0x1111111111111111111111111111111111111111', 1000)]],
    ['for less', [transfer(PAY_TO, 999)]],
    ['of another token', [transfer(PAY_TO, 1000, '0x2222222222222222222222222222222222222222')]]
  ])('reports a nonce spent on a transfer %s as another transfer', async (_label, logs) => {
    expect(await observeAuthorization(P, { urls: twice({ used: true, logs }) })).toEqual({ state: 'other' });
  });

  it('reports a failed transaction as another transfer', async () => {
    expect(await observeAuthorization(P, { urls: twice({ used: true, logs: [transfer(PAY_TO, 1000)], status: '0x0' }) })).toEqual({ state: 'other' });
  });

  it('believes no single endpoint: one answer, or two that disagree, is unknown', async () => {
    const honest = node({ used: false });
    expect(await observeAuthorization(P, { urls: network({ 'https://a.test': honest }) })).toEqual({ state: 'unknown' });
    expect(await observeAuthorization(P, { urls: network({ 'https://liar.test': node({ lie: true }), 'https://a.test': honest }) })).toEqual({ state: 'unknown' });
    expect(await observeAuthorization(P, { urls: network({ 'https://liar.test': node({ lie: true }), 'https://a.test': honest, 'https://b.test': node({ used: false }) }) })).toEqual({ state: 'unused' });
    expect(await observeAuthorization(P, { urls: network({ 'https://down.test': 'down', 'https://a.test': honest, 'https://b.test': node({ used: false }) }) })).toEqual({ state: 'unused' });
    expect(await observeAuthorization(P, { urls: network({ 'https://down.test': 'down', 'https://a.test': honest }) })).toEqual({ state: 'unknown' });
  });

  it('answers unknown for what it cannot check', async () => {
    const urls = twice({ used: true });
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
