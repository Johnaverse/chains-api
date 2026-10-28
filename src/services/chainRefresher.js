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
import { jsonRpcCall, NO_ANSWER_FAILURES } from '../../rpcUtil.js';
import { refreshNodeForkSchedule } from '../sources/nodeForkSchedule.js';
import { safeExternalUrl, resolvesPublic } from '../util/publicHost.js';
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
import { isPrivateRpc, markPrivateRpcs, stripPrivateRpcs } from '../store/privateRpcStore.js';

// HTTP statuses that mark an RPC endpoint as non-public (see privateRpcStore).
const PRIVATE_RPC_STATUSES = new Set([401, 403]);

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

// ───────────────────────── provider back-off ─────────────────────────

// A sweep reaches one provider hundreds of times — thirdweb serves `<chainId>.rpc.thirdweb.com`
// for ~700 chains — and providers start refusing us partway through. Those refusals were
// recorded as ~1,200 failed endpoints that answered fine on their own. Once a provider limits
// us, its endpoints are not probed again until a back-off passes (doubling while it keeps
// refusing); each keeps its last result meanwhile, so a refusal never reads as an outage.
const THROTTLE_BACKOFF_MS = 10 * 60 * 1000;
const THROTTLE_BACKOFF_MAX_MS = 60 * 60 * 1000;
const throttledProviders = new Map(); // provider -> { until, backoffMs }

/** The provider behind a URL: its registrable domain, so per-chain subdomains count as one. */
export function providerOf(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  // "example.co.uk": a two-letter country code under a short second level keeps three labels.
  const keep = labels.length > 2 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

function isThrottled(url, now) {
  const entry = throttledProviders.get(providerOf(url));
  return Boolean(entry && entry.until > now);
}

function noteProviderResponses(results, now) {
  // Per provider for the whole batch: any refusal of our volume outranks a success beside it, or
  // a provider that limited this batch would be probed again at once.
  const verdict = new Map(); // provider -> 'limited' | 'ok'
  for (const r of results) {
    const provider = providerOf(r.url);
    if (!provider) continue;
    if (r.failure === 'rate_limited' || r.throttled) verdict.set(provider, 'limited');
    else if (r.ok && !verdict.has(provider)) verdict.set(provider, 'ok');
  }
  for (const [provider, v] of verdict) {
    if (v === 'limited') {
      const prev = throttledProviders.get(provider);
      const backoffMs = prev ? Math.min(prev.backoffMs * 2, THROTTLE_BACKOFF_MAX_MS) : THROTTLE_BACKOFF_MS;
      throttledProviders.set(provider, { until: now + backoffMs, backoffMs });
    } else {
      throttledProviders.delete(provider);
    }
  }
}

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

// An eth_chainId answer, only when it is wholly a quantity ("0x61", or digits): a malformed one
// ("", "0x1garbage") is no evidence of which chain an endpoint serves.
function parseChainId(value) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const n = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text, 16) : /^\d+$/.test(text) ? Number(text) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function checkRpcEndpoint(url, chainId = null) {
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
  // A public-looking name whose DNS answers a private address is the same probe by another route.
  if (!(await resolvesPublic(url))) {
    result.error = 'RPC host resolves to a non-public address';
    result.failure = 'private_address';
    return result;
  }

  const [version, block] = await Promise.allSettled([
    jsonRpcCall(url, 'web3_clientVersion', { timeoutMs: RPC_CHECK_TIMEOUT_MS }),
    jsonRpcCall(url, 'eth_blockNumber', { timeoutMs: RPC_CHECK_TIMEOUT_MS })
  ]);
  if (version.status === 'fulfilled') result.clientVersion = version.value || null;
  if (block.status === 'fulfilled') result.blockHeight = parseBlockHeight(block.value);
  // Which chain an endpoint that serves blocks actually serves. Registries list a successor's or
  // a sibling's RPC under the wrong chain (Tempo's deprecated Andantino lists Moderato's, 0G's
  // Galileo 16601 its successor's 16602), and blocks for another chain are not this chain's.
  // Asked only of an endpoint that served a block; one that does not answer eth_chainId is
  // judged on its blocks alone.
  let servedChainId = null;
  if (chainId != null && result.blockHeight !== null) {
    try {
      servedChainId = parseChainId(await jsonRpcCall(url, 'eth_chainId', { timeoutMs: RPC_CHECK_TIMEOUT_MS }));
    } catch (err) {
      // No answer: judged on its blocks. A refusal of our volume still backs the provider off
      // (noteProviderResponses), though the endpoint served its block.
      if (err?.kind === 'rate_limited') result.throttled = true;
    }
  }
  if (servedChainId != null && servedChainId !== Number(chainId)) {
    result.servedChainId = servedChainId;
    result.error = `Serves chain ${servedChainId}, not ${chainId}`;
    result.failure = 'wrong_chain';
    return result;
  }
  // Serving blocks is what makes an RPC work; some nodes disable web3_clientVersion and were
  // counted dead for it. The client version stays null then.
  result.ok = result.blockHeight !== null;
  if (!result.ok) {
    const error = block.status === 'rejected' ? block.reason : (version.status === 'rejected' ? version.reason : null);
    result.error = error?.message ?? 'No block height returned';
    // How it failed: `unreachable` / `timeout` mean nothing answered; `rpc_error`,
    // `http_error`, `rate_limited`, `invalid_response` mean something did (validation.js).
    // A node that returned its client version answered, whatever eth_blockNumber did.
    result.failure = version.status === 'fulfilled' ? 'answered_no_block' : (error?.kind ?? 'invalid_response');
    // 401/403 = the endpoint wants credentials or refuses us: not a public RPC. Rate limits
    // (429) and outages (5xx) are transient and stay listed.
    if (PRIVATE_RPC_STATUSES.has(error?.status)) result.authRequired = true;
  }
  return result;
}

/**
 * Check every RPC URL for a single chain and write results to cache.
 * Per-chain `lastTested` timestamp lands on the indexed chain entry so
 * /chains/:id surfaces freshness without a separate accessor.
 */
export async function processChainRpc(chainId) {
  // Own keys only: chainId can arrive from a request path, and '__proto__' must not resolve.
  if (!cachedData.indexed?.byChainId || !Object.hasOwn(cachedData.indexed.byChainId, chainId)) return;
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
  //
  // Endpoints that once answered HTTP 401/403 are private (see privateRpcStore) and are
  // never probed again.
  const urls = Array.from(new Set(normalized))
    .filter(u => !u.includes('${') && safeExternalUrl(u) !== null && !isPrivateRpc(u))
    .slice(0, MAX_ENDPOINTS_PER_CHAIN);
  if (urls.length === 0) return;

  const startedAt = Date.now();
  const deferred = new Set(urls.filter(u => isThrottled(u, startedAt)));
  rpcState.isMonitoring = true;
  const probed = await Promise.all(urls.filter(u => !deferred.has(u)).map(u => checkRpcEndpoint(u, chain.chainId)));
  rpcState.isMonitoring = false;
  noteProviderResponses(probed, Date.now());
  const previousByUrl = new Map((cachedData.rpcHealth?.[chainId] ?? []).map(r => [r.url, r]));
  const probedByUrl = new Map(probed.map(r => [r.url, r]));
  const results = urls.map(u => probedByUrl.get(u) ?? previousByUrl.get(u) ?? {
    url: u, ok: false, clientVersion: null, blockHeight: null,
    error: 'Not checked yet: the provider is limiting our checks', failure: 'rate_limited'
  });
  if (deferred.size > 0) incCounter('chains_api_rpc_check_total', { outcome: 'deferred' }, deferred.size);
  rpcState.endpointsCheckedThisSweep += probed.length;

  // A 401/403 is a fact about the URL, not about this data version, so record and apply it
  // before the race guard: a refresh landing mid-probe must not cost us the finding.
  const privateUrls = results.filter(r => r.authRequired).map(r => r.url);
  const newlyPrivate = privateUrls.length > 0 ? markPrivateRpcs(privateUrls) : 0;
  if (newlyPrivate > 0) {
    logger.info({ chainId, urls: privateUrls }, 'Dropped non-public RPC endpoints (HTTP 401/403)');
    incCounter('chains_api_rpc_private_dropped_total', {}, newlyPrivate);
  }
  // Strip from whatever cache is live now — the refreshed one too, if a reload landed
  // mid-probe — and from every chain listing the same URL. Idempotent.
  if (privateUrls.length > 0) stripPrivateRpcs(cachedData.indexed, cachedData.rpcHealth);

  // Race guard: a concurrent loadData() may have replaced the cache.
  if (cachedData.lastUpdated !== dataVersion) {
    logger.warn({ chainId }, 'Chain RPC check skipped: data changed during run');
    return;
  }

  const publicResults = results.filter(r => !r.authRequired);

  if (!cachedData.rpcHealth) cachedData.rpcHealth = {};
  const previous = cachedData.rpcHealth[chainId];
  // Since when an endpoint has answered nothing at all, carried across consecutive checks: one
  // silent sweep from one place proves little, days of them do (validation rule 18). Any answer
  // in between — a rate limit, an error, a block — restarts the clock.
  const now = new Date().toISOString();
  const silentSince = new Map((previous ?? []).filter(r => r.unansweredSince).map(r => [r.url, r.unansweredSince]));
  for (const r of publicResults) {
    if (!r.ok && NO_ANSWER_FAILURES.has(r.failure)) r.unansweredSince = silentSince.get(r.url) ?? now;
  }
  cachedData.rpcHealth[chainId] = publicResults;
  chain.lastTested = now;
  if (!cachedData.rpcCheckedAt) cachedData.rpcCheckedAt = {};
  cachedData.rpcCheckedAt[chainId] = now;
  // The chain's fork schedule as its nodes hold it, from an endpoint that served blocks in this
  // pass (eth_config, nodeForkSchedule.js) — not one deferred by a provider's rate-limit backoff,
  // which keeps its earlier result above. Paced by its own interval; fire-and-forget.
  // Nor one whose provider this batch just backed off (a throttled eth_chainId, a sibling's 429).
  refreshNodeForkSchedule(Number(chainId), probed.filter(r => r.ok && !r.authRequired && !isThrottled(r.url, Date.now())).map(r => r.url)).catch(() => {});
  // Freshness signal for /clients and /rpc-monitor. Stamped per chain as
  // results are written — not at sweep end — because a full sweep can abort
  // mid-pass on a data-version change (so onSweepEnd may never run), which
  // would otherwise leave lastRpcCheck (and /clients lastUpdated) null.
  cachedData.lastRpcCheck = chain.lastTested;

  // Live, incremental persistence of this chain alone: its statuses when an endpoint's up/down
  // state changed (not on every block advance), and in the database also the time of every
  // check, which orders the next pod's first sweep. Fire-and-forget; the store logs failures.
  persistChainRpcHealth(chainId, publicResults, {
    changed: rpcStateChanged(previous, publicResults),
    checkedAt: Date.parse(now)
  }).catch(() => {});

  incCounter('chains_api_rpc_check_total', { outcome: 'completed' }, probed.length);
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

// Longest-waiting first: chains never checked, then the oldest checks, the rest in registry
// order. A restart resumes where checking left off (rpcCheckedAt is restored from the store)
// instead of starting again at the registry's first chain.
export function buildSweepQueue() {
  const chains = cachedData.indexed?.all || [];
  const checkedAt = cachedData.rpcCheckedAt || {};
  const at = c => {
    const t = Date.parse(checkedAt[c.chainId] || '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  const ordered = chains.map((c, i) => ({ c, i, t: at(c) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const jobs = [{ type: 'l2beat_batch' }];
  for (const { c } of ordered) {
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
    // The registries reload on a schedule (sourceRefresher.js), so restarting
    // the sweep each time would leave its tail untested: carry on with the
    // chains the new data still has.
    if (
      cursor.sweepDataVersion !== null &&
      cachedData.lastUpdated !== cursor.sweepDataVersion
    ) {
      const before = queue.length;
      const byChainId = cachedData.indexed?.byChainId ?? {};
      queue = queue.filter(job => job.type !== 'chain_rpc' || byChainId[job.chainId]);
      cursor.sweepDataVersion = cachedData.lastUpdated;
      logger.info(
        { sweepNumber: cursor.sweepNumber, remainingJobs: queue.length, droppedJobs: before - queue.length },
        'Chain refresher sweep continues on reloaded data'
      );
      if (queue.length === 0) return;
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
  throttledProviders.clear();
  l2beatState = { lastRefreshAt: null, lastRefreshSource: null, lastRefreshProjectCount: 0, lastRefreshError: null };
  rpcState = { isMonitoring: false, lastSweepCompletedAt: null, endpointsCheckedThisSweep: 0 };
  onDemandInFlight = new Map();
  onDemandNoResultUntil = new Map();
}
