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

/** The /rpc-monitor/:id view of one chain, or null when it has no probe results. */
export async function chainRpcMonitor(chainId) {
  let results = getRpcMonitoringResults();
  let chainResults = results.results.filter(r => r.chainId === chainId);
  if (chainResults.length === 0 && await ensureChainRpcResults(chainId)) {
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

async function assemble(chainId) {
  const chain = getChainDetail(chainId);
  if (!chain) return null;
  const unavailable = {};
  const part = async (name, read) => {
    try { return (await read()) ?? null; } catch (err) { unavailable[name] = err?.message || 'failed'; return null; }
  };
  const [price, rpcMonitor, networkClients, forks, updates, maintenance] = await Promise.all([
    part('price', () => getPriceForChain(chainId)),
    part('rpcMonitor', () => chainRpcMonitor(chainId)),
    part('networkClients', () => getNetworkClients(chainId)),
    part('forks', () => getForks({ chainId, limit: 200 })),
    part('updates', () => getTimeline({ chainId, type: 'software_update', limit: 100 })),
    part('maintenance', () => getTimeline({ chainId, type: 'maintenance', limit: 100 }))
  ]);
  const report = validationReport(validateChainData);
  return {
    chainId,
    generatedAt: new Date().toISOString(),
    chain: { ...chain, price },
    relations: traverseRelations(chainId, 2),
    endpoints: getEndpointsById(chainId),
    rpcMonitor,
    rpcMonitorStatus: getRpcMonitoringStatus(),
    clients: getClientsByChain(chainId) ?? null,
    networkClients,
    forks,
    // Software updates and maintenance, each with its own limit: hardforks are in `forks`.
    events: (updates || maintenance)
      ? { entries: [...(updates?.entries ?? []), ...(maintenance?.entries ?? [])] }
      : null,
    statusPage: getStatusPageByChainId(chainId) ?? null,
    validation: report?.error ? null : findingsForChain(report, chainId),
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
