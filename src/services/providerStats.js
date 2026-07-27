import { getLiveEvents } from '../sources/liveIncidents.js';
import { getStatusNewsPages } from '../sources/statusNewsPages.js';
import { getRpcMonitoringResults } from '../store/queries.js';
import { groupEventsByIncident, MAINTENANCE_STATUSES, INCIDENT_STATUSES } from './upgrades.js';

/**
 * Per-RPC-provider quality indicators, from two deliberately separated vantage
 * points:
 *
 *   self-reported  what the provider ADMITS on its own status page (incident
 *                  counts, resolution times, selfReportedAvailability). A
 *                  provider that never posts incidents scores a perfect 1.0
 *                  here — the field name and every surface label it as
 *                  self-reported precisely because silence looks like health.
 *   our probes     chains-api's own RPC endpoint checks (endpointHealth),
 *                  matched to providers by URL domain. Independent of what the
 *                  provider chooses to publish.
 *
 * Never blend the two into one score: the honest answer to "which provider is
 * reliable" is both numbers side by side.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_DAYS = 30;

// Provider id (as used by chains-status-news statusPage.id) -> the URL domains
// its public RPC endpoints live under. Suffix-matched, so subdomains like
// eth-mainnet.g.alchemy.com match "alchemy.com". gateway.tenderly.co is a
// subdomain of tenderly.co and needs no separate entry, but stays listed to
// document the endpoint shape actually seen in the registry.
export const PROVIDER_DOMAINS = {
  infura: ['infura.io'],
  quicknode: ['quiknode.pro', 'quicknode.com'],
  alchemy: ['alchemy.com', 'alchemyapi.io'],
  chainstack: ['chainstack.com', 'p2pify.com'],
  drpc: ['drpc.org'],
  blockdaemon: ['blockdaemon.com', 'bdnodes.net'],
  blockpi: ['blockpi.io', 'blockpi.network'],
  getblock: ['getblock.io'],
  tenderly: ['tenderly.co', 'gateway.tenderly.co'],
  pinax: ['pinax.network']
};

/**
 * @param {object} [options]
 * @param {string} [options.provider] only this provider id (e.g. "infura")
 * @returns {Promise<{fetchedAt: string, windowDays: number, count: number, providers: object[]}>}
 * @throws when the incident feed is unreachable and nothing is cached
 */
export async function getProviderStats({ provider } = {}) {
  const [events, statusPages] = await Promise.all([
    getLiveEvents(),
    // Supplementary: coverage/name enrichment. Already degrades to [] inside.
    getStatusNewsPages()
  ]);
  const monitoring = getRpcMonitoringResults();

  const { windowDays, providers } = buildProviderStats(events, {
    statusPages,
    rpcResults: monitoring.results ?? []
  });

  let filtered = providers;
  if (provider) {
    const p = String(provider).toLowerCase();
    filtered = filtered.filter((it) => it.id === p);
  }

  return {
    fetchedAt: new Date().toISOString(),
    windowDays,
    count: filtered.length,
    providers: filtered
  };
}

/**
 * Pure core (exported for tests): fold the normalized update stream, the
 * feed's status-page catalog and our RPC probe results into per-provider
 * scorecards.
 *
 * @param {object[]} events full update stream from getLiveEvents()
 * @param {object} [sources]
 * @param {object[]} [sources.statusPages] status-news /status-pages entries
 * @param {object[]} [sources.rpcResults] getRpcMonitoringResults().results
 * @param {number} [sources.now] clock override for tests
 * @returns {{windowDays: number, providers: object[]}}
 */
export function buildProviderStats(events, { statusPages = [], rpcResults = [], now = Date.now() } = {}) {
  // The window is honest about feed retention: the feed keeps a few hundred
  // events, so on a young deployment "incidents in the last 30 days" would
  // silently mean "in the last N<30 days". min(30d, retention) + an exposed
  // windowDays keeps every rate denominated in time we actually observed.
  const timestamps = events.map((ev) => ev.publishedMs).filter((ms) => Number.isFinite(ms));
  const oldestMs = timestamps.length ? Math.min(...timestamps) : null;
  const windowMs = oldestMs != null ? Math.min(MAX_WINDOW_DAYS * DAY_MS, Math.max(0, now - oldestMs)) : MAX_WINDOW_DAYS * DAY_MS;
  const windowStart = now - windowMs;
  const windowDays = Math.round((windowMs / DAY_MS) * 10) / 10;

  const providerEvents = events.filter((ev) => ev.statusPage?.kind === 'rpc-provider' && ev.statusPage.id);
  const providerPages = statusPages.filter((p) => p?.kind === 'rpc-provider' && p.id);

  // Providers list = union of ids seen in events and in the catalog, so a
  // provider with a silent status page (no events in retention) still gets a
  // card — its self-reported numbers are the interesting part.
  const ids = new Set([
    ...providerEvents.map((ev) => ev.statusPage.id),
    ...providerPages.map((p) => p.id)
  ]);
  const pageById = new Map(providerPages.map((p) => [p.id, p]));
  const eventsById = new Map();
  for (const ev of providerEvents) {
    if (!eventsById.has(ev.statusPage.id)) eventsById.set(ev.statusPage.id, []);
    eventsById.get(ev.statusPage.id).push(ev);
  }

  const providers = [...ids].map((id) => {
    const page = pageById.get(id);
    const own = eventsById.get(id) ?? [];
    const groups = groupEventsByIncident(own);

    const inWindow = (group) => group.first.publishedMs != null && group.first.publishedMs >= windowStart;
    const incidentGroups = groups.filter((g) => INCIDENT_STATUSES.has(g.latest.status) && inWindow(g));
    const maintenanceGroups = groups.filter((g) => MAINTENANCE_STATUSES.has(g.latest.status) && inWindow(g));

    // Ongoing is a NOW question, not a window question: an incident opened
    // before the window that is still burning must not disappear.
    const ongoingNow = groups.filter((g) => g.latest.ongoing === true).length;

    const resolutionSamples = [];
    let downtimeMs = 0;
    for (const g of incidentGroups) {
      const firstMs = g.first.publishedMs;
      const resolved = g.updates.find((u) => u.status === 'resolved' && u.publishedMs != null);
      if (resolved && resolved.publishedMs >= firstMs) {
        resolutionSamples.push((resolved.publishedMs - firstMs) / 3600000);
        downtimeMs += Math.min(resolved.publishedMs - firstMs, windowMs);
      } else {
        // Unresolved: it has been down from first report until now, capped so
        // one stuck incident can't push availability below 0.
        downtimeMs += Math.min(Math.max(0, now - firstMs), windowMs);
      }
    }

    const chainsAffected = new Set();
    for (const g of incidentGroups) {
      for (const u of g.updates) for (const c of u.chains ?? []) if (c?.chainId != null) chainsAffected.add(c.chainId);
    }

    const coverage = page?.coverage;

    return {
      id,
      name: page?.name ?? own[0]?.statusPage?.name ?? id,
      incidents30d: incidentGroups.length,
      ongoingNow,
      maintenance30d: maintenanceGroups.length,
      chainsAffected30d: chainsAffected.size,
      resolutionHours: resolutionSamples.length
        ? { median: round1(median(resolutionSamples)), avg: round1(avg(resolutionSamples)) }
        : null,
      // What the provider ADMITS: 1.0 means "posted no incident time in the
      // window", which a silent status page also produces. Label accordingly.
      selfReportedAvailability: windowMs > 0
        ? Math.round(clamp(1 - downtimeMs / windowMs, 0, 1) * 10000) / 10000
        : null,
      endpointHealth: endpointHealthFor(id, rpcResults),
      // Self-declared coverage from the status page itself (status-news >=
      // the coverage rollout); null on feeds that predate it.
      chainsSupported: coverage?.chainsListed ?? null,
      chainsResolved: Array.isArray(coverage?.chainIdsResolved) ? coverage.chainIdsResolved.length : null
    };
  });

  providers.sort((a, b) => b.incidents30d - a.incidents30d || a.id.localeCompare(b.id));
  return { windowDays, providers };
}

/** OUR probes: registry endpoints whose hostname belongs to this provider. */
function endpointHealthFor(id, rpcResults) {
  const domains = PROVIDER_DOMAINS[id];
  if (!domains?.length) return null;
  let working = 0;
  let total = 0;
  const chains = new Set();
  for (const r of rpcResults) {
    const host = hostnameOf(r?.url);
    if (!host || !domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    total += 1;
    if (r.status === 'working') working += 1;
    if (r.chainId != null) chains.add(r.chainId);
  }
  if (total === 0) return null;
  return {
    working,
    total,
    percent: Math.round((working / total) * 1000) / 10,
    registryChains: chains.size
  };
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function round1(n) { return Math.round(n * 10) / 10; }
function avg(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
