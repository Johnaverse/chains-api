import {
  HALT_CHECK_MAX_ENDPOINTS,
  HALT_CHECK_TIMEOUT_MS,
  HALT_BLOCK_TIME_MULTIPLIER,
  HALT_MIN_SECONDS
} from '../../config.js';
import { jsonRpcCall } from '../../rpcUtil.js';
import { getChainById, getEndpointsById } from '../store/queries.js';
import { getExplorerTip } from '../sources/blockscout.js';
import { safeExternalUrl } from '../util/publicHost.js';
import { logger } from '../util/logger.js';

/**
 * Chain-halt check: decide whether a chain has stopped producing blocks.
 *
 * The whole judgement lives here rather than in the tool description, because
 * the two situations that need separating look identical from any single
 * endpoint:
 *
 *   - every live source at the SAME height, and that block older than the
 *     chain's normal block interval  ->  the chain itself is stalled
 *   - sources DISAGREEING while the leader is fresh  ->  one endpoint is
 *     lagging; the chain is fine, and saying otherwise would be wrong
 *
 * Consensus is what makes the verdict trustworthy, which is why the explorer
 * (a non-RPC stack) is worth including as an independent witness.
 *
 * Everything is probed live. The rolling refresher's cached heights carry no
 * block timestamp and no read time, so they cannot prove anything is moving.
 */

// eth_getBlockByNumber returns the header including its timestamp, which is the
// point: a block's own timestamp gives staleness from ONE sample, so there is
// no need to poll twice and wait out an interval before answering.
const LATEST_BLOCK_PARAMS = ['latest', false];

export const VERDICTS = Object.freeze({
  HALTED: 'halted',
  DELAYED: 'delayed',
  ENDPOINT_LAGGING: 'endpoint_lagging',
  HEALTHY: 'healthy',
  UNKNOWN: 'unknown'
});

function parseHexNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The chain's publicly checkable RPC URLs. Mirrors the filtering the rolling
 * refresher applies (`src/services/chainRefresher.js`): endpoints with an
 * unsubstituted `${...}` placeholder need an API key we don't have, so they can
 * never be reached and must not be counted as silent sources.
 */
function usableRpcUrls(chainId) {
  const endpoints = getEndpointsById(chainId);
  const raw = Array.isArray(endpoints?.rpc) ? endpoints.rpc : [];
  const normalized = raw
    .map((entry) => (typeof entry === 'string' ? entry : entry?.url))
    .filter((url) => typeof url === 'string' && !url.includes('${'))
    // These URLs come from the chain registry, which is community-maintained — so they are
    // attacker-influenceable, and this check is reachable on demand through the assistant.
    // Without the host filter a crafted RPC entry turns it into an internal port scanner.
    // (The background refresher probes the same list and predates this guard; that is a
    // separate, lower-exposure path, but worth closing there too.)
    .filter((url) => safeExternalUrl(url) !== null);
  return Array.from(new Set(normalized)).slice(0, HALT_CHECK_MAX_ENDPOINTS);
}

async function probeRpc(url) {
  try {
    const block = await jsonRpcCall(url, 'eth_getBlockByNumber', {
      params: LATEST_BLOCK_PARAMS,
      timeoutMs: HALT_CHECK_TIMEOUT_MS
    });
    const height = parseHexNumber(block?.number);
    const timestampSeconds = parseHexNumber(block?.timestamp);
    if (height === null || timestampSeconds === null) {
      return { source: url, kind: 'rpc', ok: false, error: 'Malformed block response' };
    }
    return { source: url, kind: 'rpc', ok: true, height, timestampMs: timestampSeconds * 1000 };
  } catch (err) {
    return { source: url, kind: 'rpc', ok: false, error: err.message };
  }
}

async function probeExplorer(chainId) {
  const tip = await getExplorerTip(chainId);
  if (!tip) return null;
  return {
    source: tip.baseUrl,
    kind: 'explorer',
    ok: true,
    height: tip.height,
    timestampMs: tip.timestampMs,
    averageBlockSeconds: tip.averageBlockSeconds
  };
}

/**
 * Average block interval, derived from RPC when the explorer cannot supply it.
 * Costs one extra call, and is what keeps the check working on the ~2200 chains
 * with no Blockscout instance.
 */
async function deriveIntervalFromRpc(url, tipHeight, tipTimestampMs) {
  const lookback = Math.min(100, tipHeight);
  if (lookback < 2) return null;
  try {
    const older = await jsonRpcCall(url, 'eth_getBlockByNumber', {
      params: [`0x${(tipHeight - lookback).toString(16)}`, false],
      timeoutMs: HALT_CHECK_TIMEOUT_MS
    });
    const olderTs = parseHexNumber(older?.timestamp);
    if (olderTs === null) return null;
    const seconds = (tipTimestampMs - olderTs * 1000) / 1000 / lookback;
    return seconds > 0 ? seconds : null;
  } catch (err) {
    logger.debug({ url, err: err.message }, 'Halt check could not derive block interval');
    return null;
  }
}

/**
 * Run the halt check for a chain.
 *
 * @param {number} chainId
 * @param {object} [deps] injection seam for tests
 * @returns {Promise<object>} verdict plus the evidence it was drawn from
 */
export async function checkChainHalt(chainId, { now = () => Date.now() } = {}) {
  const chain = getChainById(chainId);
  const urls = usableRpcUrls(chainId);

  const [rpcResults, explorerResult] = await Promise.all([
    Promise.all(urls.map(probeRpc)),
    probeExplorer(chainId).catch(() => null)
  ]);

  const sources = [...rpcResults, ...(explorerResult ? [explorerResult] : [])];
  const responded = sources.filter((s) => s.ok);
  const silent = sources.filter((s) => !s.ok);

  const base = {
    chainId,
    chainName: chain?.name ?? null,
    checkedAt: new Date(now()).toISOString(),
    sourcesQueried: sources.length,
    sourcesResponded: responded.length,
    explorerChecked: Boolean(explorerResult),
    evidence: sources.map((s) => ({
      source: s.source,
      kind: s.kind,
      ok: s.ok,
      height: s.ok ? s.height : null,
      blockAgeSeconds: s.ok ? Math.round((now() - s.timestampMs) / 1000) : null,
      error: s.ok ? null : s.error
    })),
    silentSources: silent.map((s) => s.source)
  };

  // Fewer than two witnesses cannot establish consensus, and a chain with no
  // reachable public endpoint is a gap in OUR visibility. Reporting that as a
  // halt is the exact mistake `get_rpc_monitor_by_id` was once fixed for.
  if (responded.length < 2) {
    return {
      ...base,
      verdict: VERDICTS.UNKNOWN,
      consensusHeight: responded[0]?.height ?? null,
      blockAgeSeconds: responded[0] ? Math.round((now() - responded[0].timestampMs) / 1000) : null,
      averageBlockSeconds: null,
      thresholdSeconds: null,
      reason:
        responded.length === 0
          ? 'No public RPC endpoint or explorer answered, so the chain could not be observed. This does NOT mean the chain is down.'
          : 'Only one source answered, which is not enough to tell a stalled chain from a lagging endpoint. This does NOT mean the chain is down.'
    };
  }

  const maxHeight = Math.max(...responded.map((s) => s.height));
  const leaders = responded.filter((s) => s.height === maxHeight);
  const behind = responded.filter((s) => s.height < maxHeight);
  // Use the leader's block timestamp: the tip is what says whether the chain is
  // moving, and a lagging endpoint's older block must not inflate the age.
  const tipTimestampMs = Math.max(...leaders.map((s) => s.timestampMs));
  const blockAgeSeconds = Math.round((now() - tipTimestampMs) / 1000);

  let averageBlockSeconds = explorerResult?.averageBlockSeconds ?? null;
  if (averageBlockSeconds === null) {
    const leaderRpc = leaders.find((s) => s.kind === 'rpc');
    if (leaderRpc) {
      averageBlockSeconds = await deriveIntervalFromRpc(leaderRpc.source, maxHeight, tipTimestampMs);
    }
  }

  // The floor is not a nicety: on a 2s-block chain, a bare multiple would call
  // a halt after six seconds of ordinary jitter.
  const thresholdSeconds =
    averageBlockSeconds === null
      ? HALT_MIN_SECONDS
      : Math.max(Math.round(averageBlockSeconds * HALT_BLOCK_TIME_MULTIPLIER), HALT_MIN_SECONDS);
  const overdue = blockAgeSeconds > thresholdSeconds;

  // Two different notions of "behind", and conflating them makes the tool
  // useless: on a 2s chain, half the endpoints sit one block back at any given
  // moment, and explorers trail by design while they index. Being at a lower
  // height is normal; not having seen a block in longer than the chain's own
  // interval is not.
  //   - `behind`  — lower height. Only used to decide whether consensus exists.
  //   - `stale`   — this source's OWN block is overdue. That is a real problem.
  const stale = responded.filter((s) => (now() - s.timestampMs) / 1000 > thresholdSeconds);

  const detail = {
    ...base,
    consensusHeight: maxHeight,
    blockAgeSeconds,
    averageBlockSeconds: averageBlockSeconds === null ? null : Math.round(averageBlockSeconds * 100) / 100,
    thresholdSeconds,
    agreeingSources: leaders.length,
    sourcesBehindTip: behind.length,
    laggingSources: stale.map((s) => ({
      source: s.source,
      blocksBehind: maxHeight - s.height,
      blockAgeSeconds: Math.round((now() - s.timestampMs) / 1000)
    }))
  };

  if (!overdue) {
    // A fresh tip settles it. An endpoint stuck on an old block is still worth
    // naming — that IS a real problem, just not the chain's.
    return {
      ...detail,
      verdict: stale.length > 0 ? VERDICTS.ENDPOINT_LAGGING : VERDICTS.HEALTHY,
      reason:
        stale.length > 0
          ? `The chain is producing blocks (tip #${maxHeight} is ${blockAgeSeconds}s old), but ${stale.length} source(s) are stuck on a block older than ${thresholdSeconds}s. This is an endpoint problem, NOT a chain halt.`
          : `The chain is producing blocks: tip #${maxHeight} is ${blockAgeSeconds}s old, within the expected interval.`
    };
  }

  // Overdue, but the sources disagree — the leader is simply ahead of the
  // stragglers, and we cannot say the chain stopped.
  if (behind.length > 0) {
    return {
      ...detail,
      verdict: VERDICTS.DELAYED,
      reason: `No new block for ${blockAgeSeconds}s at tip #${maxHeight} (expected roughly every ${detail.averageBlockSeconds ?? 'unknown'}s), and sources disagree on the height, so this may be a lagging endpoint rather than a halted chain.`
    };
  }

  // Every source that answered is sitting on the same overdue block. Note that
  // chains which produce blocks only on demand (idle testnets, some appchains)
  // look exactly like this, so state the observation and let the reader judge.
  return {
    ...detail,
    verdict: VERDICTS.HALTED,
    reason: `All ${responded.length} responding sources agree on block #${maxHeight}, and it is ${blockAgeSeconds}s old against an expected interval of ${detail.averageBlockSeconds ?? 'unknown'}s. The chain appears to have stopped producing blocks. (Chains that only produce blocks on demand look the same.)`
  };
}
