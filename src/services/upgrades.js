import { getLiveEvents } from '../sources/liveIncidents.js';
import { getForumNews } from '../sources/forumNews.js';
import { getWeb3News } from '../sources/web3News.js';
import { networkSlug, networkSlugs } from '../domain/networkSlug.js';
import { logger } from '../util/logger.js';

/**
 * The correlation layer: one UpgradeEvent per scheduled upgrade/maintenance window,
 * carrying everything the three feeds know about it —
 *
 *   when        activation time — the scheduled WINDOW's own timestamp, not the
 *               announcement that preceded it (see activationMsFor)
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
// The dashboard's timeline is now a range-scrubbed chart over the whole feed
// rather than a page of cards, so it asks for everything: the correlated
// upgrade->fallout pairs live in the older tail, and a 50-window cut hid every
// one of them behind the pending windows that sort first.
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 20;

// Shared with providerStats.js: both layers must classify a group as maintenance vs
// incident identically or the provider scorecard would disagree with the timeline.
export const MAINTENANCE_STATUSES = new Set(['maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed']);
export const INCIDENT_STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved', 'degraded', 'partial_outage', 'major_outage']);

/**
 * @param {object} [options]
 * @param {number} [options.chainId] only upgrades touching this chain
 * @param {string} [options.network] a network name or slug (canonicalized here)
 * @param {number} [options.limit] max upgrades returned (default 20, max 200)
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
export function buildUpgradeEvents(events, { forumPosts = [], newsItems = [], now = Date.now() } = {}) {
  const groups = groupEventsByIncident(events);

  const upgradeGroups = [];
  const incidentGroups = [];
  for (const group of groups) {
    if (MAINTENANCE_STATUSES.has(group.latest.status)) upgradeGroups.push(group);
    else if (INCIDENT_STATUSES.has(group.latest.status)) incidentGroups.push(group);
  }

  // Soonest-first for what hasn't happened, most-recent-first for what has. A caller
  // asking for 20 upgrades wants every pending window plus the freshest history, not
  // the twenty furthest-future dates.
  return upgradeGroups
    .map((group) => toUpgradeEvent(group, incidentGroups, forumPosts, newsItems, now))
    .sort((a, b) => {
      const ta = Date.parse(a.activationAt ?? '') || 0;
      const tb = Date.parse(b.activationAt ?? '') || 0;
      const aPending = ta > now;
      const bPending = tb > now;
      if (aPending !== bPending) return aPending ? -1 : 1;
      return aPending ? ta - tb : tb - ta;
    });
}

// Severity/urgency decorations providers bolt onto a title, in every casing and
// wrapper they use: "[Urgent] ", "*URGENT* ", "**Urgent** ", "[Standard] ".
// Providers add or drop them BETWEEN updates of the same incident, so a verbatim
// title is not a stable key — live proof: QuickNode posted "[Urgent] Injective
// Mainnet Upgrade to v1.20.3" and "Injective Mainnet Upgrade to v1.20.3" for one
// window, which surfaced as two separate timeline cards.
const TITLE_DECORATION = /^\s*(?:[[(*_]*\s*(?:urgent|standard|critical|mandatory|scheduled|maintenance|info|notice)\s*[\])*_]*\s*[-–—:]?\s*)+/i;

/** The grouping-key form of a title: decorations stripped, punctuation collapsed. */
export function normalizeIncidentTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(TITLE_DECORATION, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * One group per real-world incident/window.
 *
 * incidentId is the primary key — it is stable across an entry's updates and its retitles.
 * But it is an ENTRY id, not a rollout id, and the two differ for scheduled maintenance:
 * Atlassian emits the announcement and the window itself as separate objects with separate
 * GUIDs. Keying on incidentId alone therefore split 41 of 111 live windows into duplicate
 * pairs — "[Canton] Devnet Upgrade to Splice v0.6.14" appeared once for its Jul 20
 * announcement and again for its Jul 29 window.
 *
 * So maintenance groups get a second pass that folds together same-provider, same-title
 * rollouts. INCIDENTS deliberately do NOT: "Superposition Testnet RPC went down" recurs
 * verbatim across genuinely separate outages, and merging those would undercount incidents
 * and understate downtime on the provider board.
 *
 * Exported because providerStats.js must group updates the SAME way — two grouping
 * implementations would disagree on what "an incident" is.
 */
export function groupEventsByIncident(events) {
  const byKey = new Map();
  for (const ev of events) {
    const key = ev.incidentId ?? `${ev.statusPage?.id ?? 'unknown'}|${normalizeIncidentTitle(ev.title)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(ev);
  }

  const finalize = (updates) => {
    const sorted = [...updates].sort((a, b) => (a.publishedMs ?? 0) - (b.publishedMs ?? 0));
    return { updates: sorted, first: sorted[0], latest: sorted[sorted.length - 1] };
  };

  const groups = [...byKey.values()].map(finalize);
  const rollouts = new Map();
  const out = [];
  for (const group of groups) {
    if (!MAINTENANCE_STATUSES.has(group.latest.status)) { out.push(group); continue; }
    const key = `${group.latest.statusPage?.id ?? 'unknown'}|${normalizeIncidentTitle(group.latest.title)}`;
    const existing = rollouts.get(key);
    if (existing) existing.push(...group.updates);
    else { const merged = [...group.updates]; rollouts.set(key, merged); out.push({ _merged: merged }); }
  }
  return out.map((g) => (g._merged ? finalize(g._merged) : g));
}

/**
 * When the upgrade actually runs.
 *
 * A provider posts a window at least twice: an ANNOUNCEMENT ("we will upgrade on Aug 3")
 * and a WINDOW entry whose own publishedAt is the window start — often weeks later, and
 * frequently in the future. Taking the first `maintenance_scheduled` update reported the
 * announcement as the activation, which pushed every pending window into the past: the
 * dashboard read "Upcoming — 0 scheduled" while eleven windows were genuinely pending.
 *
 * Window entries are identified by the body banner (`isWindowEntry`) as well as by status,
 * because some providers label the window entry `maintenance_completed` up front — status
 * alone misses those. Of the candidates we take the NEXT future one (that is the occurrence
 * a reader is waiting for) and otherwise the most recent past one (the run that happened).
 */
function activationMsFor(updates, first, now) {
  const candidates = updates
    .filter((u) => u.isWindowEntry || u.status === 'maintenance_scheduled')
    .map((u) => u.publishedMs)
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  if (!candidates.length) return first.publishedMs ?? null;
  return candidates.find((ms) => ms > now) ?? candidates[candidates.length - 1];
}

function toUpgradeEvent(group, incidentGroups, forumPosts, newsItems, now) {
  const { updates, latest } = group;
  const activationMs = activationMsFor(updates, group.first, now);
  // The window entry for THIS activation carries the only duration the feed exposes.
  const windowEnd = updates.find((u) => u.publishedMs === activationMs && u.windowEndMs != null)?.windowEndMs ?? null;

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
    // The window's end and, with it, its duration — present only for providers whose
    // bodies carry the scheduled-event banner. Null means "we don't know how long".
    windowEndAt: windowEnd != null ? new Date(windowEnd).toISOString() : null,
    windowMinutes: windowEnd != null && activationMs != null ? Math.round((windowEnd - activationMs) / 60000) : null,
    // When the provider first told anyone. Distinct from activation, and the pair is what
    // makes "announced 12 days ahead" vs "announced 40 minutes ahead" answerable.
    announcedAt: group.first.publishedAt ?? null,
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
