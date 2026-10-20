import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(() => Promise.resolve()),
  writeFile: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
  readdir: vi.fn(),
  readFile: vi.fn()
}));
vi.mock('node:fs/promises', () => fsMock);

vi.mock('../../../config.js', () => ({
  DATA_CACHE_ENABLED: true,
  DATA_CACHE_FILE: '.cache/test-data.json'
}));

import {
  rpcStateChanged,
  persistChainRpcHealth,
  loadAllRpcHealthFromDisk
} from '../../../src/store/rpcHealthStore.js';

beforeEach(() => vi.clearAllMocks());

describe('rpcStateChanged', () => {
  it('is true when there is no prior state', () => {
    expect(rpcStateChanged(undefined, [{ url: 'a', ok: true }])).toBe(true);
  });

  it('is true when an endpoint flips up<->down', () => {
    const prev = [{ url: 'a', ok: true }];
    expect(rpcStateChanged(prev, [{ url: 'a', ok: false }])).toBe(true);
  });

  it('is true when the set of URLs changes', () => {
    expect(rpcStateChanged([{ url: 'a', ok: true }], [{ url: 'b', ok: true }])).toBe(true);
    expect(rpcStateChanged([{ url: 'a', ok: true }],
      [{ url: 'a', ok: true }, { url: 'b', ok: true }])).toBe(true);
  });

  it('is true when a down endpoint fails differently, so the failure kind is saved', () => {
    expect(rpcStateChanged([{ url: 'a', ok: false }], [{ url: 'a', ok: false, failure: 'unreachable' }])).toBe(true);
    expect(rpcStateChanged([{ url: 'a', ok: false, failure: 'timeout' }], [{ url: 'a', ok: false, failure: 'timeout' }])).toBe(false);
  });

  it('is false when only volatile fields change (block height / latency)', () => {
    const prev = [{ url: 'a', ok: true, blockHeight: 10, latencyMs: 5 }];
    const next = [{ url: 'a', ok: true, blockHeight: 99, latencyMs: 250 }];
    expect(rpcStateChanged(prev, next)).toBe(false);
  });
});

describe('persistChainRpcHealth', () => {
  it('atomically writes one chain file (temp + rename)', async () => {
    await persistChainRpcHealth(8453, [{ url: 'a', ok: true }]);
    expect(fsMock.mkdir).toHaveBeenCalled();
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const [tmpPath, body] = fsMock.writeFile.mock.calls[0];
    expect(tmpPath).toContain('rpc-health');
    expect(JSON.parse(body)).toMatchObject({ chainId: 8453, results: [{ url: 'a', ok: true }] });
    expect(fsMock.rename).toHaveBeenCalledTimes(1);
    expect(fsMock.rename.mock.calls[0][1]).toMatch(/rpc-health[/\\]8453\.json$/);
  });
});

describe('loadAllRpcHealthFromDisk', () => {
  it('returns empty when the directory does not exist', async () => {
    fsMock.readdir.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await loadAllRpcHealthFromDisk()).toEqual({ byChainId: {}, lastCheckedAt: null });
  });

  it('loads per-chain files and tracks the newest checkedAt', async () => {
    fsMock.readdir.mockResolvedValueOnce(['1.json', '10.json', 'junk.txt']);
    fsMock.readFile
      .mockResolvedValueOnce(JSON.stringify({ chainId: 1, checkedAt: '2026-01-01T00:00:00Z', results: [{ url: 'a', ok: true }] }))
      .mockResolvedValueOnce(JSON.stringify({ chainId: 10, checkedAt: '2026-02-02T00:00:00Z', results: [{ url: 'b', ok: false }] }));

    const out = await loadAllRpcHealthFromDisk();
    expect(Object.keys(out.byChainId)).toEqual(['1', '10']);
    expect(out.byChainId[10]).toEqual([{ url: 'b', ok: false }]);
    expect(out.lastCheckedAt).toBe('2026-02-02T00:00:00Z');
    expect(fsMock.readFile).toHaveBeenCalledTimes(2); // junk.txt skipped
  });

  it('skips corrupt entries without throwing', async () => {
    fsMock.readdir.mockResolvedValueOnce(['1.json', '2.json']);
    fsMock.readFile
      .mockResolvedValueOnce('not json{')
      .mockResolvedValueOnce(JSON.stringify({ chainId: 2, results: [{ url: 'c', ok: true }] }));
    const out = await loadAllRpcHealthFromDisk();
    expect(Object.keys(out.byChainId)).toEqual(['2']);
  });
});
