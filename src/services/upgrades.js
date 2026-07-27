import { getLiveEvents } from '../sources/liveIncidents.js';
import { getForumNews } from '../sources/forumNews.js';
import { getWeb3News } from '../sources/web3News.js';
import { networkSlug, networkSlugs } from '../domain/networkSlug.js';
import { logger } from '../util/logger.js';

/**
 * The correlation layer: one UpgradeEvent per scheduled upgrade/maintenance window,
 * carrying everything the three feeds know about it —
 *
 *   when        activation time (the scheduled event's own timestamp)
 *   what        required software [{client, version}] and urgency
 *   fallout     incidents on the same network within FOLLOW_WINDOW_MS after activation,
 *               labelled suspected (temporal correlation, never asserted causation)
 *   context     governance discussion (forum) and editorial coverage (news) for the
 *               same network around the window
 *
 * Join keys, in order of strength: chainId (exact), networkSlug (canonical name — covers
 * Canton/Zcash/Solana-style networks that have no EVM chainId). Measured on live data the
 * two together make ~86% of status events joinable, vs 65% for chainId alone.
 *
 * Everything here degrades gracefully: deployed feeds that predate incidentId/software/
 * networkSlugs simply yield upgrades with empty software and title-keyed grouping.
 */

// An incident this long after activation is far more likely unrelated; measured pairs on
// live data all landed within 24h (+1h..+24h).
const FOLLOW_WINDOW_MS = 24 * 60 * 60 * 1000;
// Forum/news context looks this far around the activation, both directions: discussion
// precedes an upgrade, coverage follows it.
const CONTEXT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// Shared with providerStats.js: both layers must classify a group as maintenance vs
// incident identically or the provider scorecard would disagree with the timeline.
export const MAINTENANCE_STATUSES = new Set(['maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed']);
export const INCIDENT_STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved', 'degraded', 'partial_outage', 'major_outage']);

/**
 * @param {object} [options]
 * @param {number} [options.chainId] only upgrades touching this chain
 * @param {string} [options.network] a network name or slug (canonicalized here)
 * @param {number} [options.limit] max upgrades returned (default 20, max 50)
 * @returns {Promise<{fetchedAt: string, totalMatched: number, count: number, truncated: boolean, upgrades: object[]}>}
 */
export async function getChainUpgrades({ chainId, network, limit = DEFAULT_LIMIT } = {}) {
  const events = await getLiveEvents();

  // Forum/news context is supplementary: if either sibling feed is down, upgrades still
  // answer — an empty context beats a failed call.
  const [forum, news] = await Promise.all([
    getForumNews({ limit: 50 }).catch((err) => {
      logger.warn({ err: err.message }, 'forum context unavailable for upgrades');
      return { news: [] };
    }),
    getWeb3News({ limit: 50 }).catch((err) => {
      logger.warn({ err: err.message }, 'news context unavailable for upgrades');
      return { news: [] };
    })
  ]);

  const upgrades = buildUpgradeEvents(events, { forumPosts: forum.news ?? [], newsItems: news.news ?? [] });

  let filtered = upgrades;
  if (chainId != null) filtered = filtered.filter((u) => u.chainIds.includes(Number(chainId)));
  if (network) {
    const slug = networkSlug(String(network));
    filtered = filtered.filter((u) => u.networkSlugs.includes(slug));
  }

  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const sliced = filtered.slice(0, capped);
  return {
    fetchedAt: new Date().toISOString(),
    totalMatched: filtered.length,
    count: sliced.length,
    truncated: filtered.length > sliced.length,
    upgrades: sliced
  };
}

/**
 * Pure correlation over normalized events (exported for tests).
 * @param {object[]} events full update stream from getLiveEvents()
 * @param {{forumPosts?: object[], newsItems?: object[]}} [context]
 */
export function buildUpgradeEvents(events, { forumPosts = [], newsItems = [] } = {}) {
  const groups = groupEventsByIncident(events);

  const upgradeGroups = [];
  const incidentGroups = [];
  for (const group of groups) {
    if (MAINTENANCE_STATUSES.has(group.latest.status)) upgradeGroups.push(group);
    else if (INCIDENT_STATUSES.has(group.latest.status)) incidentGroups.push(group);
  }

  return upgradeGroups
    .map((group) => toUpgradeEvent(group, incidentGroups, forumPosts, newsItems))
    .sort((a, b) => (Date.parse(b.activationAt ?? '') || 0) - (Date.parse(a.activationAt ?? '') || 0));
}

// One group per real-world incident/window. incidentId (stable across updates AND retitles)
// wins; statusPage+title is the fallback for events from feeds that predate the field.
// Exported because providerStats.js must group updates into incidents the SAME way —
// two grouping implementations would disagree on what "an incident" is.
export function groupEventsByIncident(events) {
  const byKey = new Map();
  for (const ev of events) {
    const key = ev.incidentId ?? `${ev.statusPage?.id ?? 'unknown'}|${(ev.title ?? '').toLowerCase().trim()}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(ev);
  }
  return [...byKey.values()].map((updates) => {
    const sorted = [...updates].sort((a, b) => (a.publishedMs ?? 0) - (b.publishedMs ?? 0));
    return { updates: sorted, first: sorted[0], latest: sorted[sorted.length - 1] };
  });
}

function toUpgradeEvent(group, incidentGroups, forumPosts, newsItems) {
  const { updates, latest } = group;
  // The activation time is the SCHEDULED update's own timestamp (providers set publishedAt
  // to the window start), not the newest update's — after completion the newest is the
  // "completed" entry and would misreport when the upgrade actually ran.
  const scheduled = updates.find((u) => u.status === 'maintenance_scheduled') ?? group.first;
  const activationMs = scheduled.publishedMs ?? latest.publishedMs ?? null;

  const chainIds = uniqueChainIds(updates);
  const slugs = collectSlugs(updates);

  const followedBy = incidentGroups
    .filter((inc) => {
      const incMs = inc.first.publishedMs;
      if (activationMs == null || incMs == null) return false;
      const delta = incMs - activationMs;
      if (delta <= 0 || delta > FOLLOW_WINDOW_MS) return false;
      return sharesNetwork(chainIds, slugs, uniqueChainIds(inc.updates), collectSlugs(inc.updates));
    })
    .map((inc) => ({
      title: inc.latest.title,
      url: inc.latest.url,
      status: inc.latest.status,
      startedAt: inc.first.publishedAt,
      hoursAfterActivation: Math.round((inc.first.publishedMs - activationMs) / 3600000 * 10) / 10,
      chainIds: uniqueChainIds(inc.updates),
      // Temporal correlation on the same network — never asserted as causation. The honest
      // label is what makes the field trustworthy.
      suspectedCause: 'upgrade'
    }))
    .sort((a, b) => a.hoursAfterActivation - b.hoursAfterActivation);

  const inContext = (item) => {
    const ms = Date.parse(item.publishedAt ?? '');
    if (!Number.isFinite(ms) || activationMs == null) return false;
    if (Math.abs(ms - activationMs) > CONTEXT_WINDOW_MS) return false;
    const itemChainIds = (item.chains ?? []).map((c) => c.chainId);
    const itemSlugs = networkSlugs((item.chains ?? []).map((c) => c.name).filter(Boolean));
    if (sharesNetwork(chainIds, slugs, itemChainIds, itemSlugs)) return true;
    // Version mention is a strong secondary key: a post naming v1.39.2 belongs to the
    // window requiring it even when its chain mapping failed.
    return latest.software?.some((s) => s.version && (item.title ?? '').includes(s.version)) ?? false;
  };

  const compact = (item) => ({ title: item.title, url: item.url, publishedAt: item.publishedAt });

  return {
    incidentId: latest.incidentId ?? null,
    title: latest.title,
    url: latest.url,
    provider: latest.statusPage?.id ?? null,
    status: latest.status,
    urgency: latest.urgency ?? 'standard',
    software: latest.software ?? [],
    activationAt: activationMs != null ? new Date(activationMs).toISOString() : null,
    lastUpdateAt: latest.publishedAt,
    updates: updates.length,
    chainIds,
    networkNames: latest.networkNames ?? [],
    networkSlugs: slugs,
    followedByIncidents: followedBy,
    discussion: forumPosts.filter(inContext).slice(0, 5).map(compact),
    coverage: newsItems.filter(inContext).slice(0, 5).map(compact)
  };
}

function uniqueChainIds(updates) {
  const ids = new Set();
  for (const u of updates) for (const c of u.chains ?? []) if (c?.chainId != null) ids.add(c.chainId);
  return [...ids];
}

function collectSlugs(updates) {
  const slugs = new Set();
  for (const u of updates) {
    for (const s of u.networkSlugs ?? []) slugs.add(s);
    // Derive from names too (and from chain catalog names), so events from feeds that
    // predate networkSlugs still join by name.
    for (const n of u.networkNames ?? []) { const s = networkSlug(n); if (s) slugs.add(s); }
    for (const c of u.chains ?? []) { const s = networkSlug(c?.name); if (s) slugs.add(s); }
  }
  return [...slugs];
}

function sharesNetwork(chainIdsA, slugsA, chainIdsB, slugsB) {
  if (chainIdsA.length && chainIdsB.length && chainIdsB.some((id) => chainIdsA.includes(id))) return true;
  return slugsA.length > 0 && slugsB.some((s) => slugsA.includes(s));
}
