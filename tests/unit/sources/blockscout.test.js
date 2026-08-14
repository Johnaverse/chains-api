import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getExplorerTip, _resetBlockscoutCacheForTests } from '../../../src/sources/blockscout.js';
import { proxyFetch } from '../../../fetchUtil.js';
import { getChainById } from '../../../src/store/queries.js';

vi.mock('../../../fetchUtil.js', () => ({
  proxyFetch: vi.fn()
}));

vi.mock('../../../src/store/queries.js', () => ({
  getChainById: vi.fn()
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  BLOCKSCOUT_ENABLED: true,
  BLOCKSCOUT_CACHE_TTL_MS: 15000,
  BLOCKSCOUT_INSTANCE_CACHE_TTL_MS: 21600000,
  BLOCKSCOUT_FETCH_TIMEOUT_MS: 1000,
  // 1000 rps -> a 1ms pacing interval, so the pacer never slows the suite down.
  BLOCKSCOUT_MAX_RPS: 1000
}));

/**
 * A blocks listing shaped like the real /api/v2/blocks?type=block response:
 * newest first, and NOT contiguous — the real endpoint skips heights, which is
 * why the interval is derived from the height span rather than the item count.
 */
function blocksPayload({ tip = 1000, intervalSeconds = 12, tipIso = '2026-08-07T12:00:00.000Z' } = {}) {
  const tipMs = Date.parse(tipIso);
  const items = [];
  for (let i = 0; i < 10; i += 1) {
    const height = tip - i * 2;
    items.push({
      height,
      timestamp: new Date(tipMs - i * 2 * intervalSeconds * 1000).toISOString()
    });
  }
  const body = JSON.stringify({ items });
  return { ok: true, status: 200, headers: new Headers(), text: async () => body, json: async () => ({ items }) };
}

function notFound() {
  return { ok: false, status: 404, headers: new Headers(), text: async () => '{}', json: async () => ({}) };
}

const blockscoutChain = { explorers: [{ name: 'blockscout', url: 'https://eth.blockscout.com' }] };

describe('blockscout source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetBlockscoutCacheForTests();
  });

  it('resolves the instance from the chain explorers and reports the tip', async () => {
    getChainById.mockReturnValue(blockscoutChain);
    proxyFetch.mockResolvedValue(blocksPayload({ tip: 1000, intervalSeconds: 12 }));

    const tip = await getExplorerTip(1);

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(proxyFetch.mock.calls[0][0]).toBe('https://eth.blockscout.com/api/v2/blocks?type=block');
    expect(tip).toMatchObject({ baseUrl: 'https://eth.blockscout.com', height: 1000 });
    expect(tip.timestampMs).toBe(Date.parse('2026-08-07T12:00:00.000Z'));
  });

  it('derives the average block interval from the height span, not the item count', async () => {
    // 10 items spanning 18 heights: dividing by the item count would give 21.6s
    // for a 12s chain, which would then be used as the halt threshold.
    getChainById.mockReturnValue(blockscoutChain);
    proxyFetch.mockResolvedValue(blocksPayload({ tip: 1000, intervalSeconds: 12 }));

    const tip = await getExplorerTip(1);

    expect(tip.averageBlockSeconds).toBe(12);
  });

  it('caches the miss for a chain with no Blockscout explorer without any request', async () => {
    getChainById.mockReturnValue({ explorers: [{ name: 'etherscan', url: 'https://etherscan.io' }] });

    expect(await getExplorerTip(1)).toBeNull();
    expect(await getExplorerTip(1)).toBeNull();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it('caches the miss when the instance URL looks right but the API does not answer', async () => {
    // Without a negative cache this re-probes on every question, which is
    // exactly when the user is asking repeatedly.
    getChainById.mockReturnValue(blockscoutChain);
    proxyFetch.mockResolvedValue(notFound());

    expect(await getExplorerTip(1)).toBeNull();
    expect(await getExplorerTip(1)).toBeNull();
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the negative instance result past the short stats TTL', async () => {
    // The two caches have very different lifetimes on purpose: stats expire in
    // seconds (liveness data), but "this chain has no instance" holds for
    // hours. Without the long one, every explorer-less chain re-probes as soon
    // as the stats entry ages out.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      getChainById.mockReturnValue(blockscoutChain);
      proxyFetch.mockResolvedValue(notFound());

      expect(await getExplorerTip(1)).toBeNull();
      expect(proxyFetch).toHaveBeenCalledTimes(1);

      // Past the 15s stats TTL, far short of the 6h instance TTL.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await getExplorerTip(1)).toBeNull();
      expect(proxyFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent calls for the same chain into one request', async () => {
    getChainById.mockReturnValue(blockscoutChain);
    proxyFetch.mockResolvedValue(blocksPayload());

    const [a, b, c] = await Promise.all([getExplorerTip(1), getExplorerTip(1), getExplorerTip(1)]);

    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('parks the host after a 429 instead of retrying it', async () => {
    // A retry storm against a shared per-IP limit is what gets an IP blocked.
    getChainById.mockReturnValue(blockscoutChain);
    proxyFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'x-ratelimit-reset': '60' }),
      text: async () => '{}', json: async () => ({})
    });

    expect(await getExplorerTip(1)).toBeNull();
    expect(proxyFetch).toHaveBeenCalledTimes(1);

    // A different chain on the same parked host must also be skipped, so the
    // park is a property of the host and not of one cache entry.
    expect(await getExplorerTip(2)).toBeNull();
    expect(proxyFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null rather than throwing when the request fails', async () => {
    getChainById.mockReturnValue(blockscoutChain);
    proxyFetch.mockRejectedValue(new Error('timed out'));

    await expect(getExplorerTip(1)).resolves.toBeNull();
  });

  it('falls through to the second candidate when the first instance is dead', async () => {
    getChainById.mockReturnValue({
      explorers: [
        { name: 'blockscout', url: 'https://dead.blockscout.com' },
        { name: 'blockscout', url: 'https://live.blockscout.com' }
      ]
    });
    proxyFetch.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(blocksPayload({ tip: 77 }));

    const tip = await getExplorerTip(1);

    expect(tip).toMatchObject({ baseUrl: 'https://live.blockscout.com', height: 77 });
  });

  it('accepts a plain-string explorer entry', async () => {
    // The TheGraph registry contributes explorer URLs as bare strings, not objects.
    getChainById.mockReturnValue({ explorers: ['https://gnosis.blockscout.com'] });
    proxyFetch.mockResolvedValue(blocksPayload({ tip: 42 }));

    const tip = await getExplorerTip(1);

    expect(tip).toMatchObject({ baseUrl: 'https://gnosis.blockscout.com', height: 42 });
  });

  it('refuses an explorer URL pointing inside the cluster', async () => {
    // chains.json is community-maintained, so these URLs are attacker-influenceable input.
    // Without this the halt check — reachable from the assistant — becomes an internal port
    // scanner: "http://10.43.0.1:8080/blockscout" matches the blockscout filter perfectly.
    for (const url of [
      'http://10.43.0.1:8080/blockscout',
      'http://127.0.0.1:4000/blockscout',
      'http://169.254.169.254/blockscout',
      'http://litellm.litellm.svc.cluster.local:4000/blockscout',
      'http://blockscout/api',
      'http://192.168.1.5/blockscout',
      'http://172.16.0.9/blockscout'
    ]) {
      _resetBlockscoutCacheForTests();
      getChainById.mockReturnValue({ explorers: [{ name: 'blockscout', url }] });
      expect(await getExplorerTip(1)).toBeNull();
      expect(proxyFetch).not.toHaveBeenCalled();
    }
  });

  it('still accepts an ordinary public explorer', async () => {
    getChainById.mockReturnValue({ explorers: [{ name: 'blockscout', url: 'https://eth.blockscout.com' }] });
    proxyFetch.mockResolvedValue(blocksPayload({ tip: 5 }));
    expect(await getExplorerTip(1)).toMatchObject({ height: 5 });
  });

  it('ignores a response whose declared length is over the cap', async () => {
    // The payload here is PERFECTLY VALID and small — only the declared length is absurd. An
    // earlier version of this test sent junk, so it passed on the JSON parse error whether or
    // not the cap existed: green for the wrong reason.
    getChainById.mockReturnValue({ explorers: [{ name: 'blockscout', url: 'https://eth.blockscout.com' }] });
    const valid = blocksPayload({ tip: 1000 });
    proxyFetch.mockResolvedValue({
      ...valid,
      headers: new Headers({ 'content-length': String(50 * 1024 * 1024) })
    });
    expect(await getExplorerTip(1)).toBeNull();
  });

  it('ignores an oversized body that declared no length', async () => {
    // Valid JSON again, genuinely over the cap: a declared length is only a claim, so the
    // decoded size has to be checked too.
    getChainById.mockReturnValue({ explorers: [{ name: 'blockscout', url: 'https://eth.blockscout.com' }] });
    const items = Array.from({ length: 40000 }, (_, i) => ({
      height: 1000 - i, timestamp: '2026-08-07T12:00:00.000Z', padding: 'x'.repeat(60)
    }));
    const body = JSON.stringify({ items });
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024);   // the fixture must actually exceed it
    proxyFetch.mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), text: async () => body, json: async () => ({ items })
    });
    expect(await getExplorerTip(1)).toBeNull();
  });
});
