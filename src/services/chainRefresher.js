/**
 * Unified rolling refresher.
 *
 * Replaces the two parallel scheduler patterns (services/rpcHealth.js
 * setInterval + services/l2beatRefresher.js setInterval) with one queue
 * and one tick. Every SWEEP_TICK_MS the loop pops a single job:
 *
 *   queue = [
 *     { type: 'l2beat_batch' },                                 // 1 job
 *     { type: 'chain_rpc', chainId: N }, { type: 'chain_rpc', chainId: M }, ...
 *   ]
 *
 * When the queue empties, a fresh sweep is enqueued from the current
 * indexed chains. This spreads RPC fan-out evenly across the sweep
 * window (~5 min for 300 chains at 1 tick/sec) instead of a thundering
 * herd at start-of-loop.
 *
 * The existing services/rpcHealth.js and services/l2beatRefresher.js
 * modules become thin shims delegating to this module so the old API
 * surface (startRpcHealthCheck, startL2BeatRefresh, getRpcMonitoringStatus,
 * getL2BeatRefreshStatus, runRpcHealthCheck, runL2BeatRefresh) keeps
 * working unchanged.
 */
import { jsonRpcCall } from '../../rpcUtil.js';
import { safeExternalUrl } from '../util/publicHost.js';
import {
  RPC_CHECK_TIMEOUT_MS,
  L2BEAT_REFRESH_INTERVAL_MS,
  MAX_ENDPOINTS_PER_CHAIN
} from '../../config.js';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';
import { cachedData } from '../store/cache.js';
import { indexL2BeatSource } from '../store/indexer.js';
import { fetchL2Beat } from '../sources/l2beat.js';
import { persistChainRpcHealth, rpcStateChanged } from '../store/rpcHealthStore.js';

const SWEEP_TICK_MS = Number(process.env.CHAIN_REFRESHER_TICK_MS) || 1000;

let queue = [];
let cursor = {
  jobIndex: 0,
  totalJobs: 0,
  sweepNumber: 0,
  sweepStartedAt: null,
  // Snapshot of cachedData.lastUpdated at sweep start. Used to detect
  // inter-job races (loadData() ran between job N and job N+1). The
  // remaining jobs in the sweep are dropped on detection so a refresh
  // doesn't write a frankensweep of mixed data versions.
  sweepDataVersion: null
};
let tickTimer = null;
let tickInFlight = false;
let lastTickAt = null;
let lastTickJobType = null;

// Per-job-type status (read by the legacy getX status accessors).
let l2beatState = {
  lastRefreshAt: null,
  lastRefreshSource: null,
  lastRefreshProjectCount: 0,
  lastRefreshError: null
};

let rpcState = {
  isMonitoring: false,
  lastSweepCompletedAt: null,
  endpointsCheckedThisSweep: 0
};

// ───────────────────────── job processors ─────────────────────────

function normalizeRpcUrl(rpcEntry) {
  if (!rpcEntry) return null;
  if (typeof rpcEntry === 'string') return rpcEntry;
  if (typeof rpcEntry === 'object' && rpcEntry.url) return rpcEntry.url;
  return null;
}

function parseBlockHeight(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.startsWith('0x')) {
      const parsed = Number.parseInt(value, 16);
      return Number.isNaN(parsed) ? null : parsed;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

async function checkRpcEndpoint(url) {
  const result = { url, ok: false, clientVersion: null, blockHeight: null, error: null };

  // Registry URLs are community-submitted input, not configuration, so a host check belongs
  // here and not only at the call site: this function is also reached by the on-demand path
  // (ensureChainRpcResults). Without it a crafted entry has the refresher probe cluster-internal
  // addresses on our behalf.
  if (safeExternalUrl(url) === null) {
    result.error = 'Unsupported or non-public RPC URL';
    return result;
  }
  if (url.includes('${')) {
    result.error = 'RPC URL requires API key substitution';
    return result;
  }

  try {
    const [clientVersion, blockNumber] = await Promise.all([
      jsonRpcCall(url, 'web3_clientVersion', { timeoutMs: RPC_CHECK_TIMEOUT_MS }),
      jsonRpcCall(url, 'eth_blockNumber', { timeoutMs: RPC_CHECK_TIMEOUT_MS })
    ]);
    result.clientVersion = clientVersion || null;
    result.blockHeight = parseBlockHeight(blockNumber);
    result.ok = Boolean(result.clientVersion) && result.blockHeight !== null;
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

/**
 * Check every RPC URL for a single chain and write results to cache.
 * Per-chain `lastTested` timestamp lands on the indexed chain entry so
 * /chains/:id surfaces freshness without a separate accessor.
 */
export async function processChainRpc(chainId) {
  if (!cachedData.indexed?.byChainId?.[chainId]) return;
  const chain = cachedData.indexed.byChainId[chainId];

  const dataVersion = cachedData.lastUpdated;
  const normalized = (chain.rpc || []).map(normalizeRpcUrl).filter(Boolean);
  // Dedupe, keep only HTTP(S), drop key-templated endpoints, then cap per-chain
  // fan-out so large chain entries don't create per-tick request bursts that
  // ignore the configured MAX_ENDPOINTS_PER_CHAIN ceiling.
  //
  // Endpoints with an unsubstituted `${...}` placeholder (e.g.
  // https://mainnet.infura.io/v3/${INFURA_API_KEY}) require an API key we don't
  // have, so they can never be reached. Exclude them entirely rather than
  // report them as perpetually "failed" — they aren't real public endpoints.
  //
  // Non-public hosts are dropped for the same reason they are refused in checkRpcEndpoint —
  // and dropped HERE too so they never consume one of the MAX_ENDPOINTS_PER_CHAIN slots that a
  // reachable endpoint could have used.
  const urls = Array.from(new Set(normalized))
    .filter(u => !u.includes('${') && safeExternalUrl(u) !== null)
    .slice(0, MAX_ENDPOINTS_PER_CHAIN);
  if (urls.length === 0) return;

  rpcState.isMonitoring = true;
  const results = await Promise.all(urls.map(checkRpcEndpoint));
  rpcState.isMonitoring = false;
  rpcState.endpointsCheckedThisSweep += results.length;

  // Race guard: a concurrent loadData() may have replaced the cache.
  if (cachedData.lastUpdated !== dataVersion) {
    logger.warn({ chainId }, 'Chain RPC check skipped: data changed during run');
    return;
  }

  if (!cachedData.rpcHealth) cachedData.rpcHealth = {};
  const previous = cachedData.rpcHealth[chainId];
  cachedData.rpcHealth[chainId] = results;
  chain.lastTested = new Date().toISOString();
  // Freshness signal for /clients and /rpc-monitor. Stamped per chain as
  // results are written — not at sweep end — because a full sweep can abort
  // mid-pass on a data-version change (so onSweepEnd may never run), which
  // would otherwise leave lastRpcCheck (and /clients lastUpdated) null.
  cachedData.lastRpcCheck = chain.lastTested;

  // Live, incremental persistence: write only this chain's state, and only
  // when an endpoint's up/down status actually changed (not on every block
  // advance). Fire-and-forget; the store logs its own failures.
  if (rpcStateChanged(previous, results)) {
    persistChainRpcHealth(chainId, results).catch(() => {});
  }

  incCounter('chains_api_rpc_check_total', { outcome: 'completed' }, results.length);
}

// On-demand checks triggered by /rpc-monitor/:id (and the MCP tool) when the
// rolling sweep hasn't reached a chain yet — the post-deploy blind window
// otherwise lasts up to a full sweep (~50 min for ~3k chains). One probe per
// chain at a time; a chain that yields no usable results (no public HTTP
// endpoints) is not re-probed for a cooldown so repeated queries can't fan out
// requests.
const ON_DEMAND_NO_RESULT_COOLDOWN_MS = 60000;
let onDemandInFlight = new Map();
let onDemandNoResultUntil = new Map();

/**
 * Make sure rpcHealth results exist for a chain, probing its endpoints now if
 * the sweep hasn't produced any. Resolves true when results are available.
 */
export async function ensureChainRpcResults(chainId) {
  if (cachedData.rpcHealth?.[chainId]?.length) return true;
  if (!cachedData.indexed?.byChainId?.[chainId]) return false;
  if ((onDemandNoResultUntil.get(chainId) || 0) > Date.now()) return false;

  let inFlight = onDemandInFlight.get(chainId);
  if (!inFlight) {
    incCounter('chains_api_rpc_check_total', { outcome: 'on_demand' });
    inFlight = processChainRpc(chainId)
      .catch(err => logger.warn({ chainId, err: err.message }, 'On-demand RPC check failed'))
      .finally(() => onDemandInFlight.delete(chainId));
    onDemandInFlight.set(chainId, inFlight);
  }
  await inFlight;

  const hasResults = Boolean(cachedData.rpcHealth?.[chainId]?.length);
  if (!hasResults) onDemandNoResultUntil.set(chainId, Date.now() + ON_DEMAND_NO_RESULT_COOLDOWN_MS);
  return hasResults;
}

/**
 * Fetch L2BEAT data and re-merge into the index. Mirrors the previous
 * runL2BeatRefresh contract but lives inside the unified scheduler.
 */
export async function processL2BeatBatch() {
  if (!cachedData.indexed) {
    logger.warn('L2BEAT refresh skipped: data not loaded');
    return { skipped: 'no-data' };
  }

  const dataVersion = cachedData.lastUpdated;
  let fresh;
  try {
    fresh = await fetchL2Beat();
  } catch (err) {
    l2beatState.lastRefreshError = err.message;
    logger.error({ err: err.message }, 'L2BEAT refresh failed');
    incCounter('chains_api_refresh_total', { refresher: 'l2beat', outcome: 'error' });
    return { skipped: 'fetch-error', error: err.message };
  }

  if (cachedData.lastUpdated !== dataVersion) {
    logger.warn('L2BEAT refresh skipped: data changed during run');
    incCounter('chains_api_refresh_total', { refresher: 'l2beat', outcome: 'data-changed' });
    return { skipped: 'data-changed' };
  }

  cachedData.l2beat = fresh;
  indexL2BeatSource(fresh, cachedData.indexed);

  l2beatState.lastRefreshAt = new Date().toISOString();
  l2beatState.lastRefreshSource = fresh.source;
  l2beatState.lastRefreshProjectCount = fresh.projects.length;
  l2beatState.lastRefreshError = null;

  logger.info(
    { source: fresh.source, projects: fresh.projects.length },
    'L2BEAT refresh completed'
  );
  incCounter('chains_api_refresh_total', { refresher: 'l2beat', outcome: fresh.source });
  return { source: fresh.source, projectCount: fresh.projects.length };
}

// ───────────────────────── scheduler ─────────────────────────

function buildSweepQueue() {
  const chains = cachedData.indexed?.all || [];
  const jobs = [{ type: 'l2beat_batch' }];
  for (const c of chains) {
    jobs.push({ type: 'chain_rpc', chainId: c.chainId });
  }
  return jobs;
}

function onSweepStart() {
  cursor = {
    jobIndex: 0,
    totalJobs: queue.length,
    sweepNumber: cursor.sweepNumber + 1,
    sweepStartedAt: new Date().toISOString(),
    sweepDataVersion: cachedData.lastUpdated
  };
  rpcState.endpointsCheckedThisSweep = 0;
}

function onSweepEnd() {
  rpcState.lastSweepCompletedAt = new Date().toISOString();
  cachedData.lastRpcCheck = rpcState.lastSweepCompletedAt;
  logger.info(
    {
      sweepNumber: cursor.sweepNumber,
      endpointsChecked: rpcState.endpointsCheckedThisSweep,
      durationMs: Date.now() - new Date(cursor.sweepStartedAt).getTime()
    },
    'Chain refresher sweep completed'
  );
  // RPC-health is persisted incrementally per chain in processChainRpc (on
  // state change), so there is nothing to flush here at sweep end.
}

export async function tickOnce() {
  if (tickInFlight) return;
  tickInFlight = true;
  lastTickAt = new Date().toISOString();
  try {
    if (queue.length === 0) {
      queue = buildSweepQueue();
      onSweepStart();
    }

    // Inter-job race guard: if a concurrent loadData() bumped lastUpdated
    // mid-sweep, the queue references chainIds from the old data version.
    // Drop the rest of the sweep — the next tick will rebuild from scratch.
    if (
      cursor.sweepDataVersion !== null &&
      cachedData.lastUpdated !== cursor.sweepDataVersion
    ) {
      logger.warn(
        { sweepNumber: cursor.sweepNumber, droppedJobs: queue.length },
        'Chain refresher sweep aborted: data version changed mid-sweep'
      );
      queue = [];
      return;
    }

    const job = queue.shift();
    cursor.jobIndex++;
    lastTickJobType = job?.type ?? null;

    if (job?.type === 'l2beat_batch') {
      await processL2BeatBatch();
    } else if (job?.type === 'chain_rpc') {
      await processChainRpc(job.chainId);
    }

    if (queue.length === 0 && cursor.totalJobs > 0) {
      onSweepEnd();
    }
  } catch (err) {
    logger.error({ err: err.message || err }, 'Chain refresher tick failed');
  } finally {
    tickInFlight = false;
  }
}

export function startChainRefresher() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tickOnce().catch(err => logger.error({ err: err.message || err }, 'Tick swallowed error'));
  }, SWEEP_TICK_MS);
  tickTimer.unref?.();
  // Kick off the first tick immediately so the first L2BEAT batch happens
  // without waiting one SWEEP_TICK_MS.
  tickOnce().catch(err => logger.error({ err: err.message || err }, 'Initial tick swallowed error'));
}

export function stopChainRefresher() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export function getChainRefresherStatus() {
  return {
    tickIntervalMs: SWEEP_TICK_MS,
    isTickInFlight: tickInFlight,
    lastTickAt,
    lastTickJobType,
    queueDepth: queue.length,
    sweep: cursor,
    l2beat: {
      ...l2beatState,
      intervalMs: L2BEAT_REFRESH_INTERVAL_MS
    },
    rpc: {
      isMonitoring: rpcState.isMonitoring,
      lastSweepCompletedAt: rpcState.lastSweepCompletedAt,
      endpointsCheckedThisSweep: rpcState.endpointsCheckedThisSweep
    }
  };
}

// Test-only helper.
export function _resetChainRefresherForTests() {
  stopChainRefresher();
  queue = [];
  cursor = { jobIndex: 0, totalJobs: 0, sweepNumber: 0, sweepStartedAt: null, sweepDataVersion: null };
  tickInFlight = false;
  lastTickAt = null;
  lastTickJobType = null;
  l2beatState = { lastRefreshAt: null, lastRefreshSource: null, lastRefreshProjectCount: 0, lastRefreshError: null };
  rpcState = { isMonitoring: false, lastSweepCompletedAt: null, endpointsCheckedThisSweep: 0 };
  onDemandInFlight = new Map();
  onDemandNoResultUntil = new Map();
}
