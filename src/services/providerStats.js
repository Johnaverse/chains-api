import { getLiveEvents } from '../sources/liveIncidents.js';
import { getStatusNewsPages } from '../sources/statusNewsPages.js';
import { getRpcMonitoringResults } from '../store/queries.js';
import { groupEventsByIncident, MAINTENANCE_STATUSES, INCIDENT_STATUSES } from './upgrades.js';

/**
 * Per-RPC-provider quality indicators. Two metrics that must never be
 * conflated:
 *
 *   availability          THE availability metric, CHAIN-WEIGHTED per window:
 *                         1 − chain-hours lost / (chainsSupported × window
 *                         hours). A provider is a fleet — 1 of its 10 chains
 *                         down for a full 24h window is 90% availability, not
 *                         0%. The denominator is ONLY what the provider's own
 *                         status page lists (coverage.chainsListed); with no
 *                         coverage the percents are null rather than invented
 *                         from a registry. Self-reported — a provider that
 *                         never posts incidents scores a perfect 100, which is
 *                         why every surface labels it (basis + selfReported).
 *   endpointReachability  whether the REGISTRY-LISTED endpoint URLs for this
 *                         provider answer our probes. A failed probe usually
 *                         means a keyed/stale/geo-blocked registry URL, not a
 *                         down provider — this is a registry data-quality
 *                         signal, NOT provider uptime, and must never be
 *                         presented as such.
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
 * @returns {Promise<{fetchedAt: string, windowDays: number, oldestEventAt: string|null, count: number, providers: object[]}>}
 * @throws when the incident feed is unreachable and nothing is cached
 */
export async function getProviderStats({ provider } = {}) {
  const [events, statusPages] = await Promise.all([
    getLiveEvents(),
    // Supplementary: coverage/name enrichment. Already degrades to [] inside.
    getStatusNewsPages()
  ]);
  const monitoring = getRpcMonitoringResults();

  const { windowDays, oldestEventAt, providers } = buildProviderStats(events, {
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
    oldestEventAt,
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
 * @returns {{windowDays: number, oldestEventAt: string|null, providers: object[]}}
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
    // ALL incident-class groups feed availability (each availability window
    // clips intervals itself); the 30d counters keep the retention-honest window.
    const allIncidentGroups = groups.filter((g) => INCIDENT_STATUSES.has(g.latest.status) && g.first.publishedMs != null);
    const incidentGroups = allIncidentGroups.filter(inWindow);
    const maintenanceGroups = groups.filter((g) => MAINTENANCE_STATUSES.has(g.latest.status) && inWindow(g));

    // Ongoing is a NOW question, not a window question: an incident opened
    // before the window that is still burning must not disappear.
    const ongoingNow = groups.filter((g) => g.latest.ongoing === true).length;

    const resolutionSamples = [];
    for (const g of incidentGroups) {
      const firstMs = g.first.publishedMs;
      const resolved = g.updates.find((u) => u.status === 'resolved' && u.publishedMs != null);
      if (resolved && resolved.publishedMs >= firstMs) {
        resolutionSamples.push((resolved.publishedMs - firstMs) / 3600000);
      }
    }

    const chainsAffected = new Set();
    for (const g of incidentGroups) {
      for (const u of g.updates) for (const c of u.chains ?? []) if (c?.chainId != null) chainsAffected.add(c.chainId);
    }

    const coverage = page?.coverage;
    // The denominator is ONLY the provider's own status-page chain count. No
    // registry fallback: the registry knows which of its URLs belong to a
    // provider, not how many chains the provider serves.
    const chainsSupported = coverage?.chainsListed ?? null;

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
      availability: chainWeightedAvailability(allIncidentGroups, { chainsSupported, now, oldestMs }),
      endpointReachability: endpointReachabilityFor(id, rpcResults),
      // Self-declared coverage from the status page itself (status-news >=
      // the coverage rollout); null on feeds that predate it.
      chainsSupported,
      chainsResolved: Array.isArray(coverage?.chainIdsResolved) ? coverage.chainIdsResolved.length : null
    };
  });

  providers.sort((a, b) => b.incidents30d - a.incidents30d || a.id.localeCompare(b.id));
  return {
    windowDays,
    // The feed fetch is capped (~500 events): a 30d availability computed from
    // less history must be detectable. Callers get the raw horizon here; each
    // availability object carries a 'partial window' note when affected.
    oldestEventAt: oldestMs != null ? new Date(oldestMs).toISOString() : null,
    providers
  };
}

// Availability windows. Fixed spans (unlike the retention-clamped 30d counter
// window): each carries its own 'partial window' note instead when the feed
// horizon is younger than the span.
const AVAILABILITY_WINDOWS = [
  ['last24h', DAY_MS],
  ['last7d', 7 * DAY_MS],
  ['last30d', 30 * DAY_MS]
];

/**
 * Chain-weighted, per-window: percent = 1 − chainHoursLost / (chainsSupported
 * × windowHours). Worked example: a provider supporting 10 chains with one
 * incident taking 1 chain down for the whole 24h window is 90% available.
 *
 * Numerator rules:
 * - an incident's affected chains = the distinct chainIds across its updates;
 *   an incident mapping to NO chain counts as 1 chain-equivalent (provider-wide
 *   /dashboard incidents can't be attributed — undercounting beats charging
 *   all N chains), clamped to chainsSupported when known;
 * - duration = first update → first resolved update (or now while unresolved),
 *   clipped to each window;
 * - overlapping intervals are merged PER CHAIN before summing, so two
 *   simultaneous incidents on the same chain don't double-count its downtime.
 */
function chainWeightedAvailability(incidentGroups, { chainsSupported, now, oldestMs }) {
  // Downtime intervals per chain key. Unmapped groups get a synthetic key each
  // (they are distinct real-world incidents; only same-chain overlap merges).
  const intervalsByChain = new Map();
  incidentGroups.forEach((g, idx) => {
    const startMs = g.first.publishedMs;
    const resolved = g.updates.find((u) => u.status === 'resolved' && u.publishedMs != null);
    const endMs = resolved && resolved.publishedMs >= startMs ? resolved.publishedMs : now;
    if (endMs <= startMs) return;
    let keys = [...new Set(g.updates.flatMap((u) => (u.chains ?? []).map((c) => c?.chainId).filter((cid) => cid != null)))];
    if (!keys.length) keys = [`unmapped:${idx}`];
    // chainsListed can be smaller than the chains an incident claims; the
    // denominator is authoritative, so clamp the charge to it.
    if (chainsSupported != null && chainsSupported > 0 && keys.length > chainsSupported) {
      keys = keys.slice(0, chainsSupported);
    }
    for (const key of keys) {
      if (!intervalsByChain.has(key)) intervalsByChain.set(key, []);
      intervalsByChain.get(key).push([startMs, endMs]);
    }
  });

  const notes = [];
  if (chainsSupported == null) notes.push('chain coverage unavailable');
  if (oldestMs != null && oldestMs > now - 30 * DAY_MS) notes.push('partial window');

  const availability = {};
  for (const [name, spanMs] of AVAILABILITY_WINDOWS) {
    let lostMs = 0;
    for (const intervals of intervalsByChain.values()) {
      lostMs += mergedOverlapMs(intervals, now - spanMs, now);
    }
    const capacityMs = chainsSupported != null && chainsSupported > 0 ? chainsSupported * spanMs : null;
    const chargedMs = capacityMs != null ? Math.min(lostMs, capacityMs) : lostMs;
    availability[name] = {
      percent: capacityMs != null
        ? Math.round(clamp(1 - chargedMs / capacityMs, 0, 1) * 10000) / 100
        : null,
      chainHoursLost: Math.round((chargedMs / 3600000) * 100) / 100
    };
  }
  availability.basis = 'status-page-chains';
  availability.selfReported = true;
  availability.chainsSupported = chainsSupported;
  if (notes.length) availability.note = notes.join('; ');
  return availability;
}

/** Total time covered by `intervals` within [winStart, winEnd], overlaps merged. */
function mergedOverlapMs(intervals, winStart, winEnd) {
  const clipped = intervals
    .map(([s, e]) => [Math.max(s, winStart), Math.min(e, winEnd)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of clipped) {
    if (curEnd == null || s > curEnd) {
      if (curEnd != null) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd != null) total += curEnd - curStart;
  return total;
}

/**
 * Registry-endpoint reachability: do the REGISTRY-LISTED URLs under this
 * provider's domains answer our probes? Keyed endpoints fail by design, stale
 * or geo-blocked registry entries fail too — so a low percent flags registry
 * data quality, not a down provider. Never present this as uptime.
 */
function endpointReachabilityFor(id, rpcResults) {
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
