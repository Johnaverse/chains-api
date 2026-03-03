import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetchUtil before importing
vi.mock('../../fetchUtil.js', () => ({
  proxyFetch: vi.fn(),
}));

import { proxyFetch } from '../../fetchUtil.js';
import { jsonRpcCall } from '../../rpcUtil.js';

describe('rpcUtil - jsonRpcCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should make a successful JSON-RPC call and return result', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1a2b3c' }),
    });

    const result = await jsonRpcCall('https://rpc.example.com', 'eth_blockNumber');
    expect(result).toBe('0x1a2b3c');
    expect(proxyFetch).toHaveBeenCalledWith(
      'https://rpc.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_blockNumber',
          params: [],
        }),
      })
    );
  });

  it('should pass custom params', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: '0xabc' }),
    });

    await jsonRpcCall('https://rpc.example.com', 'eth_getBalance', {
      params: ['0x1234', 'latest'],
    });

    const callArgs = JSON.parse(vi.mocked(proxyFetch).mock.calls[0][1].body);
    expect(callArgs.params).toEqual(['0x1234', 'latest']);
  });

  it('should throw on HTTP error', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(jsonRpcCall('https://rpc.example.com', 'eth_blockNumber'))
      .rejects.toThrow('HTTP 500');
  });

  it('should throw on JSON-RPC error with message', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid request' },
      }),
    });

    await expect(jsonRpcCall('https://rpc.example.com', 'eth_blockNumber'))
      .rejects.toThrow('Invalid request');
  });

  it('should throw on JSON-RPC error without message (uses JSON.stringify fallback)', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600 },
      }),
    });

    await expect(jsonRpcCall('https://rpc.example.com', 'eth_blockNumber'))
      .rejects.toThrow('{"code":-32600}');
  });

  it('should throw timeout error on AbortError', async () => {
    vi.mocked(proxyFetch).mockRejectedValue(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

    await expect(jsonRpcCall('https://rpc.example.com', 'eth_blockNumber'))
      .rejects.toThrow('RPC request timed out');
  });

  it('should re-throw non-abort errors', async () => {
    vi.mocked(proxyFetch).mockRejectedValue(new Error('Network failure'));

    await expect(jsonRpcCall('https://rpc.example.com', 'eth_blockNumber'))
      .rejects.toThrow('Network failure');
  });

  it('should use default params and timeout', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: 'geth/v1.0' }),
    });

    const result = await jsonRpcCall('https://rpc.example.com', 'web3_clientVersion');
    expect(result).toBe('geth/v1.0');

    const callArgs = JSON.parse(vi.mocked(proxyFetch).mock.calls[0][1].body);
    expect(callArgs.params).toEqual([]);
  });

  it('should accept custom timeout', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: 'ok' }),
    });

    // Just verify it doesn't throw with custom timeout
    const result = await jsonRpcCall('https://rpc.example.com', 'test_method', {
      timeoutMs: 5000,
    });
    expect(result).toBe('ok');
  });

  it('should pass abort signal to proxyFetch', async () => {
    vi.mocked(proxyFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: 'ok' }),
    });

    await jsonRpcCall('https://rpc.example.com', 'test_method');

    const fetchOptions = vi.mocked(proxyFetch).mock.calls[0][1];
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('should trigger setTimeout abort callback on actual timeout', async () => {
    // Mock proxyFetch to never resolve (simulating a hung request)
    vi.mocked(proxyFetch).mockImplementation(() =>
      new Promise((_, reject) => {
        // Listen for abort signal
        const signal = vi.mocked(proxyFetch).mock.calls[0]?.[1]?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          });
        }
      })
    );

    await expect(
      jsonRpcCall('https://rpc.example.com', 'eth_blockNumber', { timeoutMs: 50 })
    ).rejects.toThrow('RPC request timed out');
  }, 5000);
});
