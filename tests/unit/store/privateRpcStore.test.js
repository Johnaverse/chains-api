import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(() => Promise.resolve()),
  writeFile: vi.fn(() => Promise.resolve()),
  rename: vi.fn(() => Promise.resolve()),
  rm: vi.fn(() => Promise.resolve()),
  readFile: vi.fn()
}));
vi.mock('node:fs/promises', () => fsMock);

vi.mock('../../../config.js', () => ({
  DATA_CACHE_ENABLED: true,
  DATA_CACHE_FILE: '.cache/test-data.json'
}));

import {
  isPrivateRpc,
  markPrivateRpcs,
  stripPrivateRpcs,
  loadPrivateRpcsFromDisk,
  _resetPrivateRpcsForTests
} from '../../../src/store/privateRpcStore.js';

beforeEach(() => {
  vi.clearAllMocks();
  _resetPrivateRpcsForTests();
});

describe('privateRpcStore', () => {
  it('persists only when a new URL is marked', async () => {
    expect(markPrivateRpcs(['https://a.example'])).toBe(1);
    await vi.waitFor(() => expect(fsMock.rename).toHaveBeenCalledTimes(1));
    const [, payload] = fsMock.writeFile.mock.calls[0];
    expect(JSON.parse(payload)).toEqual({ urls: ['https://a.example'] });

    expect(markPrivateRpcs(['https://a.example'])).toBe(0);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });

  it('serializes writes so the last one holds every URL marked', async () => {
    let release;
    fsMock.writeFile.mockImplementationOnce(() => new Promise(r => { release = r; }));
    markPrivateRpcs(['https://a.example']);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    markPrivateRpcs(['https://b.example']);
    markPrivateRpcs(['https://c.example']);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1); // second pass waits for the first
    release();

    await vi.waitFor(() => expect(fsMock.rename).toHaveBeenCalledTimes(2));
    const last = JSON.parse(fsMock.writeFile.mock.calls[1][1]);
    expect(last.urls).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
    expect(fsMock.writeFile.mock.calls[0][0]).not.toBe(fsMock.writeFile.mock.calls[1][0]);
  });

  it('strips private URLs from both index copies and rpcHealth', () => {
    markPrivateRpcs(['https://keyed.example']);
    const chain = { chainId: 1, rpc: ['https://pub.example', { url: 'https://keyed.example' }] };
    const listCopy = { chainId: 1, rpc: ['https://keyed.example', 'https://pub.example'] };
    const rpcHealth = { 1: [{ url: 'https://pub.example' }, { url: 'https://keyed.example' }] };

    stripPrivateRpcs({ byChainId: { 1: chain }, all: [listCopy] }, rpcHealth);

    expect(chain.rpc).toEqual(['https://pub.example']);
    expect(listCopy.rpc).toEqual(['https://pub.example']);
    expect(rpcHealth[1]).toEqual([{ url: 'https://pub.example' }]);
  });

  it('restores the set from disk and tolerates a missing file', async () => {
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify({ urls: ['https://keyed.example', 7] }));
    expect(await loadPrivateRpcsFromDisk()).toBe(1);
    expect(isPrivateRpc('https://keyed.example')).toBe(true);

    _resetPrivateRpcsForTests();
    fsMock.readFile.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'ENOENT' }));
    expect(await loadPrivateRpcsFromDisk()).toBe(0);
  });
});
