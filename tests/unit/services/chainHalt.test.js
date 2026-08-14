import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkChainHalt, VERDICTS } from '../../../src/services/chainHalt.js';
import { jsonRpcCall } from '../../../rpcUtil.js';
import { getChainById, getEndpointsById } from '../../../src/store/queries.js';
import { getExplorerTip } from '../../../src/sources/blockscout.js';

vi.mock('../../../rpcUtil.js', () => ({ jsonRpcCall: vi.fn() }));
vi.mock('../../../src/sources/blockscout.js', () => ({ getExplorerTip: vi.fn() }));
vi.mock('../../../src/store/queries.js', () => ({
  getChainById: vi.fn(),
  getEndpointsById: vi.fn()
}));

vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal()),
  HALT_CHECK_MAX_ENDPOINTS: 8,
  HALT_CHECK_TIMEOUT_MS: 1000,
  HALT_BLOCK_TIME_MULTIPLIER: 3,
  HALT_MIN_SECONDS: 90
}));

const NOW_MS = Date.parse('2026-08-07T12:00:00.000Z');
const now = () => NOW_MS;

const A = 'https://a.rpc.test';
const B = 'https://b.rpc.test';

/** An eth_getBlockByNumber header: both fields are hex, and the timestamp is in seconds. */
function block(height, ageSeconds) {
  return {
    number: `0x${height.toString(16)}`,
    timestamp: `0x${Math.floor((NOW_MS - ageSeconds * 1000) / 1000).toString(16)}`
  };
}

/** Route each endpoint to its own tip; block-interval lookbacks fall through. */
function rpcReturning(byUrl, { lookbackIntervalSeconds = null } = {}) {
  jsonRpcCall.mockImplementation(async (url, _method, { params } = {}) => {
    if (params?.[0] !== 'latest') {
      if (lookbackIntervalSeconds === null) throw new Error('no history');
      const tip = byUrl[url];
      const lookback = tip.number ? 100 : 0;
      const tipSeconds = Number.parseInt(tip.timestamp, 16);
      return { timestamp: `0x${(tipSeconds - lookback * lookbackIntervalSeconds).toString(16)}` };
    }
    const result = byUrl[url];
    if (result instanceof Error) throw result;
    return result;
  });
}

function explorerAt(height, ageSeconds, averageBlockSeconds = 12) {
  return {
    baseUrl: 'https://x.blockscout.com',
    height,
    timestampMs: NOW_MS - ageSeconds * 1000,
    averageBlockSeconds
  };
}

describe('chain halt check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChainById.mockReturnValue({ name: 'Testchain' });
    getEndpointsById.mockReturnValue({ rpc: [A, B] });
    getExplorerTip.mockResolvedValue(null);
  });

  it('calls it halted when every source agrees on one overdue block', async () => {
    rpcReturning({ [A]: block(1000, 600), [B]: block(1000, 600) });
    getExplorerTip.mockResolvedValue(explorerAt(1000, 600));

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.HALTED);
    expect(result.consensusHeight).toBe(1000);
    expect(result.blockAgeSeconds).toBe(600);
    expect(result.sourcesResponded).toBe(3);
    expect(result.reason).toMatch(/on demand/i); // the known false positive is stated
  });

  it('calls a trailing endpoint endpoint_lagging, never halted', async () => {
    // The distinction the whole check exists for: the chain is fine, one
    // endpoint is behind. Reporting a halt here would be wrong.
    rpcReturning({ [A]: block(1000, 5), [B]: block(990, 130) });
    getExplorerTip.mockResolvedValue(explorerAt(1000, 5));

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.ENDPOINT_LAGGING);
    expect(result.laggingSources).toEqual([{ source: B, blocksBehind: 10, blockAgeSeconds: 130 }]);
    expect(result.reason).toMatch(/NOT a chain halt/);
  });

  it('does not call a one-block gap lagging on a fast chain', async () => {
    // Observed live on Base: five sources one block back on a 2s chain, and an
    // explorer trailing while it indexes. Treating any height difference as lag
    // made endpoint_lagging the default verdict for a perfectly healthy chain.
    rpcReturning({ [A]: block(1000, 3), [B]: block(999, 3) });
    getExplorerTip.mockResolvedValue(explorerAt(990, 21, 2));

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.HEALTHY);
    expect(result.laggingSources).toEqual([]);
    expect(result.sourcesBehindTip).toBe(2); // the height gap is still reported
  });

  it('measures age from the leader, not from a trailing endpoint', async () => {
    // Taking the oldest source's block age would make a healthy chain with one
    // stale endpoint look halted.
    rpcReturning({ [A]: block(1000, 5), [B]: block(900, 3600) });

    const result = await checkChainHalt(1, { now });

    expect(result.blockAgeSeconds).toBe(5);
    expect(result.verdict).toBe(VERDICTS.ENDPOINT_LAGGING);
  });

  it('calls it healthy when the agreed tip is fresh', async () => {
    rpcReturning({ [A]: block(1000, 5), [B]: block(1000, 5) });
    getExplorerTip.mockResolvedValue(explorerAt(1000, 5));

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.HEALTHY);
    expect(result.laggingSources).toEqual([]);
  });

  it('holds the floor on a fast chain instead of alarming on jitter', async () => {
    // 2s blocks x3 is 6s. Without the floor, a 10s gap would read as a halt.
    rpcReturning({ [A]: block(1000, 10), [B]: block(1000, 10) });
    getExplorerTip.mockResolvedValue(explorerAt(1000, 10, 2));

    const result = await checkChainHalt(1, { now });

    expect(result.thresholdSeconds).toBe(90);
    expect(result.verdict).toBe(VERDICTS.HEALTHY);
  });

  it('reports unknown, not halted, when only one source answers', async () => {
    rpcReturning({ [A]: block(1000, 9999), [B]: new Error('ECONNREFUSED') });

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.UNKNOWN);
    expect(result.reason).toMatch(/does NOT mean the chain is down/);
  });

  it('reports unknown when nothing answers at all', async () => {
    rpcReturning({ [A]: new Error('timeout'), [B]: new Error('timeout') });

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.UNKNOWN);
    expect(result.sourcesResponded).toBe(0);
    expect(result.silentSources).toEqual([A, B]);
    expect(result.reason).toMatch(/does NOT mean the chain is down/);
  });

  it('reports unknown for a chain with no publicly checkable endpoints', async () => {
    getEndpointsById.mockReturnValue({ rpc: [] });

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.UNKNOWN);
    expect(result.sourcesQueried).toBe(0);
  });

  it('derives the block interval from RPC when no explorer exists', async () => {
    // ~2200 registry chains have no Blockscout instance; the check must still
    // work for them rather than fall back to a blanket threshold.
    rpcReturning({ [A]: block(1000, 600), [B]: block(1000, 600) }, { lookbackIntervalSeconds: 30 });

    const result = await checkChainHalt(1, { now });

    expect(result.explorerChecked).toBe(false);
    expect(result.averageBlockSeconds).toBe(30);
    expect(result.thresholdSeconds).toBe(90); // 30 x 3
    expect(result.verdict).toBe(VERDICTS.HALTED);
  });

  it('still answers when the interval cannot be derived at all', async () => {
    rpcReturning({ [A]: block(1000, 600), [B]: block(1000, 600) });

    const result = await checkChainHalt(1, { now });

    expect(result.averageBlockSeconds).toBeNull();
    expect(result.thresholdSeconds).toBe(90);
    expect(result.verdict).toBe(VERDICTS.HALTED);
  });

  it('says delayed, not halted, when an overdue tip is disputed', async () => {
    rpcReturning({ [A]: block(1000, 600), [B]: block(999, 900) });
    getExplorerTip.mockResolvedValue(explorerAt(999, 900));

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.DELAYED);
  });

  it('skips endpoints needing an API key rather than counting them silent', async () => {
    // ${INFURA_API_KEY}-style URLs can never be reached, so treating them as
    // non-responding sources would drag every verdict toward unknown.
    getEndpointsById.mockReturnValue({
      rpc: [A, 'https://mainnet.infura.io/v3/${INFURA_API_KEY}', 'wss://ws.rpc.test', A]
    });
    rpcReturning({ [A]: block(1000, 5) });

    const result = await checkChainHalt(1, { now });

    expect(result.sourcesQueried).toBe(1);
    expect(jsonRpcCall).toHaveBeenCalledTimes(1);
  });

  it('survives an explorer failure by degrading to RPC only', async () => {
    getExplorerTip.mockRejectedValue(new Error('blockscout exploded'));
    rpcReturning({ [A]: block(1000, 5), [B]: block(1000, 5) });

    const result = await checkChainHalt(1, { now });

    expect(result.verdict).toBe(VERDICTS.HEALTHY);
    expect(result.explorerChecked).toBe(false);
  });

  it('records per-source evidence so the answer can be quoted rather than inferred', async () => {
    rpcReturning({ [A]: block(1000, 5), [B]: new Error('ECONNREFUSED') });
    getExplorerTip.mockResolvedValue(explorerAt(1000, 5));

    const result = await checkChainHalt(1, { now });

    expect(result.evidence).toEqual([
      { source: A, kind: 'rpc', ok: true, height: 1000, blockAgeSeconds: 5, error: null },
      { source: B, kind: 'rpc', ok: false, height: null, blockAgeSeconds: null, error: 'ECONNREFUSED' },
      { source: 'https://x.blockscout.com', kind: 'explorer', ok: true, height: 1000, blockAgeSeconds: 5, error: null }
    ]);
  });
});
