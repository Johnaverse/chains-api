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
    //
    // Maintenance in progress is NOT an incident. The feed sets ongoing:true on
    // both, and counting them together made QuickNode read "4 ongoing" in an
    // alarm-red badge when all four were planned upgrades running to schedule —
    // 10 of the 12 live ongoing events were maintenance. They are reported
    // separately so a surface can show a planned window as planned.
    const ongoing = groups.filter((g) => g.latest.ongoing === true);
    // The two status sets are NOT a cover of what the feed emits — `status` is passed
    // through unvalidated and `unknown` is carried by 178 of 438 live events. Partitioning
    // on them alone would let an ongoing event of unlabelled kind fall out of BOTH counters
    // and disappear from every surface, where the previous `ongoing.length` always showed
    // it. Anything not clearly labelled maintenance counts as an incident: planned work is
    // reliably labelled, so the unlabelled case is more likely an incident, and surfacing
    // it in red is the safer failure.
    const ongoingMaintenanceGroups = ongoing.filter((g) => MAINTENANCE_STATUSES.has(g.latest.status));
    const ongoingIncidents = ongoing.filter((g) => !MAINTENANCE_STATUSES.has(g.latest.status));
    const ongoingNow = ongoingIncidents.length;
    const ongoingMaintenance = ongoingMaintenanceGroups.length;
    // When the longest-running open INCIDENT started. With resolution times
    // almost never observable this is the one duration the feeds DO expose, and
    // it separates a provider with a 12-day-open outage from one with a fresh
    // blip — a distinction the incident COUNT completely hides.
    const ongoingStarts = ongoingIncidents.map((g) => g.first.publishedMs).filter((ms) => Number.isFinite(ms));
    const oldestOngoingAt = ongoingStarts.length ? new Date(Math.min(...ongoingStarts)).toISOString() : null;

    // Time-to-resolve, but only where the feed actually witnessed the incident OPEN.
    // Most providers publish a history RSS whose only entry per incident is the final
    // "resolved" one; measuring first->resolved on those yields exactly 0h, which
    // rendered as a confident "~0h resolves in (median)" on nine of ten cards. An
    // unobserved duration is unknown, not instant — so require the resolved update to
    // be a LATER update than the first.
    const resolutionSamples = [];
    for (const g of incidentGroups) {
      const firstMs = g.first.publishedMs;
      const resolved = g.updates.find((u) => u !== g.first && u.status === 'resolved' && u.publishedMs != null);
      if (resolved && resolved.publishedMs > firstMs) {
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
      ongoingMaintenance,
      oldestOngoingAt,
      maintenance30d: maintenanceGroups.length,
      chainsAffected30d: chainsAffected.size,
      resolutionHours: resolutionSamples.length
        // `samples` travels with the number because most pages expose an open->resolved
        // transition for only a handful of their incidents; "22.6h" off 1 of 16 is a
        // data point, and the UI has to be able to say so.
        ? { median: round1(median(resolutionSamples)), avg: round1(avg(resolutionSamples)), samples: resolutionSamples.length }
        : null,
      availability: chainWeightedAvailability(allIncidentGroups, { chainsSupported, now, oldestMs }),
      // What this provider's status page actually publishes. Without it a reader
      // ranks providers by incident count and concludes the quietest page is the
      // best operator — Blockdaemon posts 20 maintenance windows and 1 incident,
      // Alchemy posts 19 incidents; that gap is editorial policy, not reliability.
      disclosure: disclosureFor({ incidentGroups, maintenanceGroups, resolutionSamples, chainsSupported }),
      // 30 daily buckets, oldest first — the sparkline series. Provider pages are
      // bursty, and a shape ("quiet, then three bad days") carries information no
      // single 30d number does.
      dailySeries: dailySeries(allIncidentGroups, maintenanceGroups, now),
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

const SPARK_DAYS = 30;

/**
 * Per-day incident/maintenance/chain-hours-lost buckets, oldest first. An incident
 * spanning days is charged to the day it OPENED (the count is "incidents started"),
 * while the hours it cost are spread across the days it actually burned — the two
 * answer different questions and conflating them would make a single long outage
 * look like a daily recurrence.
 */
function dailySeries(incidentGroups, maintenanceGroups, now) {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const buckets = [];
  for (let i = SPARK_DAYS - 1; i >= 0; i -= 1) {
    const from = dayStart - i * DAY_MS;
    buckets.push({ date: new Date(from).toISOString().slice(0, 10), incidents: 0, maintenance: 0, chainHoursLost: 0, _from: from });
  }
  const indexOf = (ms) => {
    const i = SPARK_DAYS - 1 - Math.floor((dayStart - Math.floor(ms / DAY_MS) * DAY_MS) / DAY_MS);
    return i >= 0 && i < SPARK_DAYS ? i : -1;
  };

  for (const g of maintenanceGroups) {
    const i = indexOf(g.first.publishedMs);
    if (i >= 0) buckets[i].maintenance += 1;
  }
  for (const g of incidentGroups) {
    const startMs = g.first.publishedMs;
    const i = indexOf(startMs);
    if (i >= 0) buckets[i].incidents += 1;

    // Same rule as the availability numerator: an unpublished duration
    // contributes no hours, so the sparkline and the percent agree.
    const endMs = downtimeEndMs(g, now);
    if (endMs == null) continue;
    const chains = Math.max(1, new Set(g.updates.flatMap((u) => (u.chains ?? []).map((c) => c?.chainId).filter((c) => c != null))).size);
    for (const b of buckets) {
      const overlap = Math.min(endMs, b._from + DAY_MS) - Math.max(startMs, b._from);
      if (overlap > 0) b.chainHoursLost += (overlap / 3600000) * chains;
    }
  }
  return buckets.map(({ _from, ...b }) => ({ ...b, chainHoursLost: Math.round(b.chainHoursLost * 100) / 100 }));
}

/**
 * What this page discloses, so the UI can refuse to rank on a metric a provider
 * doesn't publish. `comparable` is the honest gate on availability: it is only a
 * like-for-like number when the page names the chains it covers AND posts incidents
 * at all — a page that never posts scores a silent, meaningless 100%.
 */
function disclosureFor({ incidentGroups, maintenanceGroups, resolutionSamples, chainsSupported }) {
  return {
    postsIncidents: incidentGroups.length > 0,
    postsMaintenance: maintenanceGroups.length > 0,
    // Fraction of incidents where the page showed an open->resolved transition. MTTR
    // computed off anything less than a decent share of them is a sample, not a rate.
    resolutionTracked: incidentGroups.length ? Math.round((resolutionSamples.length / incidentGroups.length) * 100) / 100 : 0,
    publishesChainCoverage: chainsSupported != null,
    comparable: chainsSupported != null && incidentGroups.length > 0
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
  let measured = 0;
  let unknownDuration = 0;
  incidentGroups.forEach((g, idx) => {
    const startMs = g.first.publishedMs;
    const endMs = downtimeEndMs(g, now);
    // An incident whose duration the page never published is UNKNOWN, not
    // ongoing. Treating it as "still down until now" charged Infura 21 days of
    // outage for an incident it resolved on 7 July and reported 96% for the
    // last 24 hours on a quiet day. 143 of 149 live incidents appear exactly
    // once — at resolution — so this was the dominant term in every number.
    if (endMs == null) { unknownDuration += 1; return; }
    measured += 1;
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
  if (unknownDuration > 0) notes.push(`${unknownDuration} incident${unknownDuration === 1 ? '' : 's'} of unpublished duration excluded`);

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
  // How much of the incident history actually fed the number. With
  // measuredIncidents near zero the percent means "nothing is burning right
  // now", not "a clean month" — consumers must be able to tell those apart.
  availability.measuredIncidents = measured;
  availability.unknownDurationIncidents = unknownDuration;
  if (notes.length) availability.note = notes.join('; ');
  return availability;
}

/**
 * When an incident stopped costing availability, or null when the page never said.
 *
 * Three cases, and the third is the common one:
 *   observed    a later update flips to resolved -> that timestamp, the real duration
 *   ongoing     the feed still marks it live      -> now, it is genuinely burning
 *   unpublished a lone entry in a terminal state  -> null; the page posted the incident
 *               only once, at resolution, so its start and duration are unknowable from
 *               the feed. Inventing "until now" is the worst of the three options —
 *               it silently converts old, closed incidents into current downtime.
 */
function downtimeEndMs(group, now) {
  const startMs = group.first.publishedMs;
  const resolved = group.updates.find((u) => u !== group.first && u.status === 'resolved' && u.publishedMs != null);
  if (resolved && resolved.publishedMs > startMs) return resolved.publishedMs;
  if (group.latest.ongoing === true) return now;
  return null;
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
