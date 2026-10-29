import { getChainDetail, getEndpointsById, getRpcMonitoringResults } from '../store/queries.js';
import { traverseRelations } from '../domain/relations.js';
import { getPriceForChain } from '../../priceService.js';
import { getClientsByChain, summarizeChainClients } from '../../clientsView.js';
import { getNetworkClients } from '../sources/clientFeed.js';
import { getStatusPageByChainId } from '../sources/statusPages.js';
import { getForks } from './forks.js';
import { getTimeline } from './timeline.js';
import { validateChainData } from './validation.js';
import { validationReport, findingsForChain } from './validationReport.js';
import { ensureChainRpcResults } from './chainRefresher.js';
import { getRpcMonitoringStatus } from './rpcHealth.js';

/**
 * Everything a chain's profile page shows, in one response: the dashboard made ~10 requests
 * per profile, which a reader opening a few profiles a minute ran into the per-visitor rate
 * limit with. Each part is the same data its own endpoint serves; a part whose source fails is
 * null with its reason in `unavailable`, never a failed page. Assembled at most once per
 * PROFILE_TTL_MS per chain.
 */
const PROFILE_TTL_MS = 30000;
const PROFILE_CACHE_MAX = 500;
const cache = new Map();

/**
 * The /rpc-monitor/:id view of one chain, or null when it has no probe results. `probe` lets a
 * chain the sweep has not reached be probed on demand (the endpoint does; the profile does not
 * wait on that and shows what is known).
 */
export async function chainRpcMonitor(chainId, { probe = true } = {}) {
  let results = getRpcMonitoringResults();
  let chainResults = results.results.filter(r => r.chainId === chainId);
  if (chainResults.length === 0 && probe && await ensureChainRpcResults(chainId)) {
    results = getRpcMonitoringResults();
    chainResults = results.results.filter(r => r.chainId === chainId);
  }
  if (chainResults.length === 0) return null;
  return {
    chainId,
    chainName: chainResults[0].chainName,
    totalEndpoints: chainResults.length,
    workingEndpoints: chainResults.filter(r => r.status === 'working').length,
    failedEndpoints: chainResults.filter(r => r.status === 'failed').length,
    rateLimitedEndpoints: chainResults.filter(r => r.status === 'rate_limited').length,
    lastUpdated: results.lastUpdated,
    endpoints: chainResults,
    clients: summarizeChainClients(chainResults)?.clients ?? []
  };
}

// A source slower than this is reported unavailable rather than holding up the whole page.
const PART_TIMEOUT_MS = 8000;
// Enough for a chain's whole timeline; hardforks are dropped from it (they are in `forks`).
const EVENTS_LIMIT = 500;

async function assemble(chainId) {
  const chain = getChainDetail(chainId);
  if (!chain) return null;
  const unavailable = {};
  // Every part guarded: a throw or a slow source makes that part null and names it here.
  const part = async (name, read) => {
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), PART_TIMEOUT_MS); });
      return (await Promise.race([Promise.resolve().then(read), timeout])) ?? null;
    } catch (err) {
      unavailable[name] = err?.message || 'failed';
      return null;
    } finally { clearTimeout(timer); }
  };
  const [price, rpcMonitor, networkClients, forks, timeline, relations, endpoints, clients, statusPage, rpcMonitorStatus, validation] = await Promise.all([
    part('price', () => getPriceForChain(chainId)),
    part('rpcMonitor', () => chainRpcMonitor(chainId, { probe: false })),
    part('networkClients', () => getNetworkClients(chainId)),
    part('forks', () => getForks({ chainId, limit: 200 })),
    part('events', () => getTimeline({ chainId, limit: EVENTS_LIMIT })),
    part('relations', () => traverseRelations(chainId, 2)),
    part('endpoints', () => getEndpointsById(chainId)),
    part('clients', () => getClientsByChain(chainId)),
    part('statusPage', () => getStatusPageByChainId(chainId)),
    part('rpcMonitorStatus', () => getRpcMonitoringStatus()),
    part('validation', () => {
      const report = validationReport(validateChainData);
      if (report?.error) throw new Error(report.error);
      return findingsForChain(report, chainId);
    })
  ]);
  return {
    chainId,
    generatedAt: new Date().toISOString(),
    chain: { ...chain, price },
    relations,
    endpoints,
    rpcMonitor,
    rpcMonitorStatus,
    clients,
    networkClients,
    forks,
    // Software updates and maintenance; hardforks are in `forks`.
    events: timeline ? { entries: (timeline.entries ?? []).filter(e => e.type !== 'hardfork') } : null,
    statusPage,
    validation,
    ...(Object.keys(unavailable).length ? { unavailable } : {})
  };
}

/** The profile of one chain, or null when no registry lists it. */
export async function getChainProfile(chainId, now = Date.now()) {
  const hit = cache.get(chainId);
  if (hit && now - hit.at < PROFILE_TTL_MS) return hit.promise;
  if (cache.size >= PROFILE_CACHE_MAX) cache.clear();
  const promise = assemble(chainId).catch(err => { cache.delete(chainId); throw err; });
  cache.set(chainId, { at: now, promise });
  return promise;
}

export function _clearChainProfileCache() { cache.clear(); }
