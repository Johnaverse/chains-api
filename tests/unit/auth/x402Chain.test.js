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

/** A node whose chain shows `used` (AuthorizationUsed in tx 0xabc with `logs`) or nothing. */
function node({ used = false, logs = [], spent = used, status = '0x1' } = {}) {
  rpc.mockImplementation(async (_url, method, params) => {
    if (method === 'eth_blockNumber') return '0x2710';
    if (method === 'eth_getLogs') return used ? [{ transactionHash: '0xabc' }] : [];
    if (method === 'eth_call') return `0x${(spent ? 1 : 0).toString(16).padStart(64, '0')}`;
    if (method === 'eth_getTransactionReceipt') return { status, logs };
    throw new Error(`unexpected ${method}`);
  });
}

beforeEach(() => { rpc.mockReset(); });

describe('observeAuthorization', () => {
  it('uses the protocol signatures', async () => {
    node();
    await observeAuthorization(P, { urls: ['https://rpc.test'] });
    const getLogs = rpc.mock.calls.find(c => c[1] === 'eth_getLogs')[2][0];
    expect(getLogs).toMatchObject({ address: ASSET, topics: [AUTH_USED, topic(PAYER), NONCE], fromBlock: '0x1388' }); // 10000 - 5000 blocks
    const call = rpc.mock.calls.find(c => c[1] === 'eth_call')[2][0];
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector('authorizationState(address,bytes32)'));
  });

  it('sees a payment to us in the transaction that used the authorization', async () => {
    node({ used: true, logs: [transfer(PAY_TO, 1000)] });
    expect(await observeAuthorization(P, { urls: ['https://rpc.test'] })).toEqual({ state: 'paid', transaction: '0xabc' });
  });

  it.each([
    ['to someone else', [transfer('0x1111111111111111111111111111111111111111', 1000)]],
    ['for less', [transfer(PAY_TO, 999)]],
    ['of another token', [transfer(PAY_TO, 1000, '0x2222222222222222222222222222222222222222')]]
  ])('reports a nonce spent on a transfer %s as another transfer', async (_label, logs) => {
    node({ used: true, logs });
    expect(await observeAuthorization(P, { urls: ['https://rpc.test'] })).toEqual({ state: 'other' });
  });

  it('reports an unspent nonce as unused, and a spent one outside the log window as unknown', async () => {
    node({ used: false, spent: false });
    expect(await observeAuthorization(P, { urls: ['https://rpc.test'] })).toEqual({ state: 'unused' });
    node({ used: false, spent: true });
    expect(await observeAuthorization(P, { urls: ['https://rpc.test'] })).toEqual({ state: 'unknown' });
  });

  it('tries the next endpoint, and answers unknown when none answers', async () => {
    node({ used: true, logs: [transfer(PAY_TO, 1000)] });
    const healthy = rpc.getMockImplementation();
    rpc.mockImplementation(async (url, ...rest) => { if (url === 'https://down.test') throw new Error('timeout'); return healthy(url, ...rest); });
    expect(await observeAuthorization(P, { urls: ['https://down.test', 'https://rpc.test'] })).toEqual({ state: 'paid', transaction: '0xabc' });
    expect(await observeAuthorization(P, { urls: ['https://down.test'] })).toEqual({ state: 'unknown' });
    expect(await observeAuthorization({ ...P, nonce: null }, { urls: ['https://rpc.test'] })).toEqual({ state: 'unknown' });
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
