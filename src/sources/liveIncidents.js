import {
  LIVE_INCIDENTS_URL,
  LIVE_INCIDENTS_CACHE_TTL_MS,
  LIVE_INCIDENTS_FETCH_TIMEOUT_MS
} from '../../config.js';
import { proxyFetch } from '../../fetchUtil.js';
import { resolveIncidentChain } from '../domain/incidentChains.js';
import { correlateChainIncidents } from '../services/chainIncidents.js';
import { hasWindowBanner, windowEndMs } from '../domain/maintenanceWindow.js';
import { logger } from '../util/logger.js';

/**
 * Live incident feed (chains-status-news). The dashboard consumes this feed
 * client-side over WebSocket; this module gives the server (assistant + MCP
 * tools) the same data via the feed's REST endpoint, behind a short in-memory
 * cache so tool calls never hammer the upstream.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;
// The feed retains a few hundred events; 500 is "everything it has".
const FEED_FETCH_LIMIT = 500;

// `incidents` is the deduped per-incident view (newest update wins) that the tools serve.
// `events` is the full normalized update stream, kept because the upgrade-correlation layer
// needs update history (a maintenance_scheduled entry's own timestamp is the activation
// time, and dedup would replace it with the newest update's).
let cache = { fetchedAt: 0, incidents: null, events: null };

export function _resetLiveIncidentsCacheForTests() {
  cache = { fetchedAt: 0, incidents: null, events: null };
}

/**
 * Fetch live incidents, optionally filtered.
 *
 * @param {object} [options]
 * @param {'chain'|'provider'|'all'} [options.type] chain-operator vs RPC-provider incidents
 * @param {number} [options.chainId] only incidents affecting this chain
 * @param {string} [options.provider] only incidents from this provider id (e.g. "infura")
 * @param {boolean} [options.ongoing] true = only active incidents, false = only non-active
 * @param {string} [options.status] only incidents in this lifecycle state (e.g.
 *   "maintenance_scheduled" for upcoming maintenance, "investigating" for open incidents)
 * @param {number} [options.limit] max incidents returned (default 30, max 100)
 * @returns {Promise<{fetchedAt: string, count: number, incidents: object[]}>}
 * @throws when the feed is unreachable and no cached data exists
 */
export async function getLiveIncidents({ type = 'all', chainId, provider, ongoing, status, limit = DEFAULT_LIMIT } = {}) {
  const incidents = await loadIncidents();
  let filtered = incidents;
  if (type === 'chain') filtered = filtered.filter((it) => !it.isProvider);
  else if (type === 'provider') filtered = filtered.filter((it) => it.isProvider);
  // Match a chain the provider DECLARED or one derived from the incident title.
  // Provider status pages are organised by provider, so a provider incident
  // almost never declares a chain — 17 of 18 ongoing ones carried none. Filtering
  // on declared chains alone answered "nothing ongoing" for a chain that three
  // providers were reporting an outage on.
  if (chainId != null) {
    filtered = filtered.filter((it) => it.chains.some((c) => c.chainId === chainId)
      || it.derivedChain?.chainId === chainId);
  }
  if (typeof ongoing === 'boolean') filtered = filtered.filter((it) => it.ongoing === ongoing);
  if (status) filtered = filtered.filter((it) => it.status === status);
  if (provider) {
    const p = String(provider).toLowerCase();
    filtered = filtered.filter((it) => it.statusPage.id?.toLowerCase() === p);
  }
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const sliced = filtered.slice(0, capped);
  return {
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    count: sliced.length,
    totalMatched: filtered.length,
    incidents: sliced,
    // Correlated across ALL ongoing provider incidents, not just the filtered
    // page: the question "is this chain in trouble" is answered by how many
    // providers agree, and a chainId filter would leave only one of them.
    chainLevel: correlateChainIncidents(incidents)
  };
}

/**
 * The full normalized update stream (no dedup), for the upgrade-correlation
 * layer. Shares the cache/TTL with getLiveIncidents, so enabling correlation
 * adds zero upstream requests.
 */
/**
 * When the cached feed data was actually fetched. Exposed because loadIncidents serves the last
 * good cache through an upstream outage, so a consumer that stamps its own "now" would present
 * stale data as fresh.
 */
export function getLiveEventsFetchedAt() {
  return cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null;
}

export async function getLiveEvents() {
  await loadIncidents();
  return cache.events ?? [];
}

async function loadIncidents() {
  if (cache.incidents && Date.now() - cache.fetchedAt < LIVE_INCIDENTS_CACHE_TTL_MS) {
    return cache.incidents;
  }
  try {
    const response = await proxyFetch(`${LIVE_INCIDENTS_URL}/events?limit=${FEED_FETCH_LIMIT}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LIVE_INCIDENTS_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Feed responded ${response.status}`);
    const body = await response.json();
    const events = Array.isArray(body?.events) ? body.events : [];
    const normalized = events.map(normalizeEvent).map(attachChain);
    cache = { fetchedAt: Date.now(), incidents: dedupeEvents(normalized), events: normalized };
    return cache.incidents;
  } catch (err) {
    if (cache.incidents) {
      logger.warn({ err: err.message }, 'Live incident feed fetch failed; serving stale cache');
      return cache.incidents;
    }
    throw new Error(`Live incident feed unavailable: ${err.message}`);
  }
}

/**
 * The feed emits one event per status update; the tool view keeps the newest
 * per incident. Grouping prefers the feed's stable `incidentId` (survives
 * retitles) and falls back to statusPage+title while deployed feeds predate
 * that field.
 */
function dedupeEvents(normalized) {
  const byKey = new Map();
  for (const ev of normalized) {
    const key = ev.incidentId ?? `${ev.statusPage.id || 'unknown'}|${ev.title.toLowerCase().trim()}`;
    const existing = byKey.get(key);
    if (existing && (existing.publishedMs ?? 0) >= (ev.publishedMs ?? 0)) continue;
    byKey.set(key, ev);
  }
  return [...byKey.values()].sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0));
}

/** One raw feed event -> the compact, token-cheap record the tools serve. */
function normalizeEvent(ev) {
  const statusPage = ev.statusPage || {};
  const publishedMs = parseEventTime(ev);
  const enrichment = slimEnrichment(ev.enrichment);
  return {
    title: ev.title || '(untitled)',
    url: ev.url || null,
    publishedAt: publishedMs != null ? new Date(publishedMs).toISOString() : null,
    publishedMs,
    // Structured incident state from the feed (Atlassian/webhook exact, or
    // text-derived server-side for feed-only providers). Kept so the assistant
    // and MCP tools can tell an active incident from a long-resolved one
    // without re-parsing titles.
    status: ev.status ?? null,
    ongoing: typeof ev.ongoing === 'boolean' ? ev.ongoing : null,
    impact: ev.impact ?? null,
    // Correlation fields (chains-status-news >= 0.1.7). Null/empty on older
    // deployments — every consumer must tolerate their absence.
    incidentId: ev.incidentId ?? null,
    software: Array.isArray(ev.software)
      ? ev.software.filter((s) => s?.version).map((s) => ({ client: s.client ?? null, version: s.version }))
      : [],
    urgency: ev.urgency ?? null,
    networkNames: Array.isArray(ev.networkNames) ? ev.networkNames.filter((n) => typeof n === 'string') : [],
    networkSlugs: Array.isArray(ev.networkSlugs) ? ev.networkSlugs.filter((s) => typeof s === 'string') : [],
    // Scheduled-window facts derived from the entry body, which we then drop:
    // the body is multi-KB of provider HTML and every consumer of this record
    // (assistant, MCP tools) pays for it in tokens. `isWindowEntry` marks the
    // update whose publishedAt IS the window start — the activation time —
    // and `windowEndMs` is the only source of window duration in the feed.
    isWindowEntry: hasWindowBanner(ev.summary),
    windowEndMs: windowEndMs(ev.summary, publishedMs),
    statusPage: { id: statusPage.id || null, name: statusPage.name || null, kind: statusPage.kind || null },
    isProvider: statusPage.kind === 'rpc-provider',
    chains: Array.isArray(ev.chains)
      ? ev.chains.filter((c) => c?.chainId != null).map((c) => ({ chainId: c.chainId, name: c.name ?? null }))
      : [],
    affectedComponents: Array.isArray(ev.affectedComponents) ? ev.affectedComponents : [],
    // A DELIBERATELY PARTIAL enrichment: `class`, `fork` and `affectedChains` only.
    //
    // The full record also carries `summary` and `context`, which are prose and cost tokens in
    // exactly the consumers this normalizer exists to keep cheap — the same reason the entry
    // body above is parsed and then dropped. These three are small, structured, and are what
    // downstream actually joins on: fork identity groups every provider window under one
    // upgrade, and affectedChains carries the network qualifier ("Stellar Mainnet", not
    // "Stellar") that scopes it.
    //
    // Omitted entirely when the event has none, so the field's presence means something.
    ...(enrichment ? { enrichment } : {})
  };
}

/**
 * The joinable part of an enrichment, or null when there is nothing to carry.
 *
 * Kept separate from normalizeEvent so the omission above is a single decision rather than
 * three inline guards, and so the "partial by design" contract has somewhere to live.
 */
function slimEnrichment(enrichment) {
  if (!enrichment || typeof enrichment !== 'object') return null;
  const slim = {};
  if (typeof enrichment.class === 'string') slim.class = enrichment.class;
  // A class the model was unsure of must not read as fact. Upstream flags roughly a third of
  // enrichments this way (mostly class `other`), and carrying the label without the caveat is
  // how a guess becomes an assertion downstream.
  if (enrichment.lowConfidence === true) slim.lowConfidence = true;
  if (Array.isArray(enrichment.affectedChains)) {
    slim.affectedChains = enrichment.affectedChains.filter((n) => typeof n === 'string');
  }
  // The chains the model NAMED, resolved against the catalog upstream. Measured on the live
  // feed, this attributes 5 events that declare no chains of their own — including OP Stack
  // windows that touch nine networks — so filtering on declared chains alone under-reports.
  if (Array.isArray(enrichment.chains)) {
    slim.chains = enrichment.chains.filter((id) => Number.isFinite(id));
  }
  if (enrichment.fork && typeof enrichment.fork === 'object') {
    const { name, activationAt, activationBlock, state } = enrichment.fork;
    slim.fork = {
      name: typeof name === 'string' ? name : null,
      activationAt: typeof activationAt === 'string' ? activationAt : null,
      activationBlock: Number.isSafeInteger(activationBlock) ? activationBlock : null,
      state: typeof state === 'string' ? state : null
    };
  }
  return Object.keys(slim).length ? slim : null;
}

/**
 * Attach the chain an incident is about, with the evidence for it.
 *
 * Separate from normalizeEvent because it needs the chain registry: resolution
 * runs against searchChains, and a record built before the registry loaded would
 * silently carry `derivedChain: null` forever. Called per load, so a registry that
 * arrives late still attributes on the next refresh.
 */
function attachChain(incident) {
  const resolved = resolveIncidentChain(incident);
  // `derivedChain` is deliberately NOT merged into `chains`: a chain read out of
  // a title is a weaker claim than one the provider declared, and collapsing them
  // would make a guess indistinguishable from a fact (SERVICE-CONTRACT rule 14).
  incident.derivedChain = resolved && resolved.evidence !== 'declared' ? resolved : null;
  incident.chainEvidence = resolved?.evidence ?? null;
  return incident;
}

function parseEventTime(ev) {
  const t = Date.parse(ev.publishedAt || ev.updatedAt || '');
  return Number.isNaN(t) ? null : t;
}
