import {
  CLIENT_FEED_URL,
  CLIENT_FEED_CACHE_TTL_MS,
  CLIENT_FEED_FETCH_TIMEOUT_MS
} from '../../config.js';
import { getFeed } from './feedHttp.js';
import { slimFork } from '../domain/forks.js';
import { logger } from '../util/logger.js';

/**
 * Blockchain client release feed (chains-client-feed), proxied for the dashboard and the MCP
 * tools. The feed has no public host, so unlike the other three feeds the browser cannot reach
 * it directly — every read goes through here.
 *
 * Each distinct upstream URL is cached for CLIENT_FEED_CACHE_TTL_MS and served stale when the
 * upstream fails (the liveIncidents pattern), so a feed restart does not blank the dashboard.
 * Every record is re-shaped field by field: the feed is new and still moving, so a missing
 * field becomes null/[] instead of reaching the browser as `undefined`.
 */

export const MAX_RELEASE_LIMIT = 500;
const MAX_CACHE_KEYS = 200;

/** The feed is not configured (CLIENT_FEED_URL unset). Routes answer 503. */
export class ClientFeedNotConfiguredError extends Error {
  constructor() {
    super('Client release feed not configured');
    this.name = 'ClientFeedNotConfiguredError';
  }
}

/** Upstream rejected the query (e.g. a `kind` it does not know). Routes answer 400. */
export class ClientFeedBadRequestError extends Error {
  constructor(message = 'Invalid query') {
    super(message);
    this.name = 'ClientFeedBadRequestError';
  }
}

/** Upstream answered 404 for a lookup. Routes answer 404. */
export class ClientFeedNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'ClientFeedNotFoundError';
  }
}

// url -> { fetchedAt, body }
const cache = new Map();

export function _resetClientFeedCacheForTests() {
  cache.clear();
}

export function clientFeedConfigured() {
  return CLIENT_FEED_URL !== '';
}

function feedBase() {
  return CLIENT_FEED_URL.replace(/\/+$/, '');
}

function buildUrl(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${feedBase()}${path}${q ? `?${q}` : ''}`;
}

async function cachedGet(path, params) {
  if (!clientFeedConfigured()) throw new ClientFeedNotConfiguredError();
  const url = buildUrl(path, params);
  const hit = cache.get(url);
  if (hit && Date.now() - hit.fetchedAt < CLIENT_FEED_CACHE_TTL_MS) {
    return { body: hit.body, fetchedAt: hit.fetchedAt, stale: false };
  }
  try {
    const response = await getFeed(url, CLIENT_FEED_FETCH_TIMEOUT_MS);
    if (response.status === 404) throw new ClientFeedNotFoundError();
    if (response.status === 400) {
      let message = 'Invalid query';
      try {
        const body = await response.json();
        if (typeof body?.message === 'string') message = body.message.slice(0, 200);
      } catch { /* keep the generic message */ }
      throw new ClientFeedBadRequestError(message);
    }
    if (!response.ok) throw new Error(`Feed responded ${response.status}`);
    const body = await response.json();
    cache.delete(url);
    cache.set(url, { fetchedAt: Date.now(), body });
    while (cache.size > MAX_CACHE_KEYS) cache.delete(cache.keys().next().value);
    return { body, fetchedAt: Date.now(), stale: false };
  } catch (err) {
    if (err instanceof ClientFeedNotFoundError || err instanceof ClientFeedBadRequestError) throw err;
    if (hit) {
      logger.warn({ err: err.message, path }, 'Client release feed fetch failed; serving stale cache');
      return { body: hit.body, fetchedAt: hit.fetchedAt, stale: true };
    }
    throw new Error(`Client release feed unavailable: ${err.message}`);
  }
}

// ─── normalizers ────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const listOf = (body, ...keys) => {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (Array.isArray(body?.[k])) return body[k];
  return [];
};

function safeInt(v) {
  if (Number.isSafeInteger(v)) return v;
  // Epochs/slots/blocks can arrive as decimal strings from a JSON-shy upstream.
  if (typeof v === 'string' && /^\d{1,16}$/.test(v)) return Number(v);
  return null;
}

/** slimFork plus the consensus-layer activation coordinates some clients state instead of a date. */
export function normalizeFork(fork) {
  const slim = slimFork(fork);
  if (!slim) return null;
  const out = { ...slim };
  const epoch = safeInt(fork.activationEpoch);
  const slot = safeInt(fork.activationSlot);
  const ts = safeInt(fork.activationTimestamp);
  if (epoch != null) out.activationEpoch = epoch;
  if (slot != null) out.activationSlot = slot;
  if (ts != null) out.activationTimestamp = ts;
  return out;
}

function normalizeChains(list) {
  return Array.isArray(list)
    ? list.filter((c) => Number.isSafeInteger(c?.chainId)).map((c) => ({ chainId: c.chainId, name: str(c.name) }))
    : [];
}

export function normalizeRelease(item) {
  const release = item?.release ?? {};
  const source = item?.source ?? {};
  const enr = item?.enrichment && typeof item.enrichment === 'object' ? item.enrichment : null;
  const fork = normalizeFork(enr?.fork);
  const forks = Array.isArray(enr?.forks) ? enr.forks.map(normalizeFork).filter(Boolean) : [];
  return {
    id: str(item?.id),
    url: str(item?.url),
    title: str(item?.title),
    publishedAt: iso(item?.publishedAt),
    // The feed's own clip of the release notes — NOT model output (that is enrichment.summary).
    summary: str(item?.summary),
    source: { id: str(source.id), name: str(source.name), kind: str(source.kind) },
    chains: normalizeChains(item?.chains),
    chainsFrom: item?.chainsFrom === 'release' || item?.chainsFrom === 'repository' ? item.chainsFrom : null,
    release: {
      repo: str(release.repo),
      tag: str(release.tag),
      version: str(release.version),
      component: str(release.component),
      origin: str(release.origin),
      prerelease: release.prerelease === true,
      mandatory: release.mandatory === true || enr?.mandatory === true
    },
    enrichment: enr
      ? {
        class: str(enr.class),
        createdAt: iso(enr.createdAt),
        summary: str(enr.summary),
        fork,
        ...(forks.length ? { forks } : {}),
        // The feed's recall net: a possible fork or mandatory upgrade the model did not confirm.
        // Never read its absence of `fork` as "no fork" when this is present.
        ...(enr.review && typeof enr.review === 'object'
          ? { review: { reasons: strList(enr.review.reasons).slice(0, 4), quotes: strList(enr.review.quotes).slice(0, 4).map((q) => q.slice(0, 200)) } }
          : {})
      }
      : null
  };
}

function normalizeLatestRelease(r, entry) {
  if (!r || typeof r !== 'object') {
    // List rows carry only the version/tag, not the release record.
    const version = str(entry?.latestVersion);
    const tag = str(entry?.latestTag);
    return version || tag ? { tag, version, publishedAt: null, url: null, prerelease: false, mandatory: false } : null;
  }
  const rel = r.release && typeof r.release === 'object' ? r.release : r;
  return {
    tag: str(rel.tag),
    version: str(rel.version),
    publishedAt: iso(r.publishedAt ?? rel.publishedAt),
    url: str(r.url ?? rel.url),
    prerelease: rel.prerelease === true,
    mandatory: rel.mandatory === true || r.enrichment?.mandatory === true
  };
}

const int = (v) => (Number.isSafeInteger(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ACTIVITY_LEVELS = new Set(['active', 'moderate', 'low', 'dormant', 'archived']);
const ATTENTION_LEVELS = new Set(['high', 'elevated', 'normal']);
const level = (v, allowed) => (allowed.has(v) ? v : null);

/**
 * A client's development activity and open-issue health, as the feed reports it. List rows
 * carry the compact form (`attention` a string); one client carries the full record (`attention`
 * an object with reasons). Null when the feed has none yet (or GitHub without a token).
 */
export function normalizeActivity(a) {
  if (!a || typeof a !== 'object') return null;
  if (typeof a.attention === 'string' || (a.attention == null && 'commits30' in a)) {
    return {
      level: level(a.level, ACTIVITY_LEVELS),
      attention: level(a.attention, ATTENTION_LEVELS),
      commits30: int(a.commits30),
      merged30: int(a.merged30),
      merged30AtLeast: a.merged30AtLeast === true,
      openIssues: int(a.openIssues),
      criticalIssues: int(a.criticalIssues),
      advisories365: int(a.advisories365),
      forkOf: str(a.forkOf),
      refreshedAt: iso(a.refreshedAt)
    };
  }
  const issues = a.issues ?? {};
  const adv = a.advisories && typeof a.advisories === 'object' ? a.advisories : null;
  return {
    refreshedAt: iso(a.refreshedAt),
    source: str(a.source),
    archived: a.archived === true,
    pushedAt: iso(a.pushedAt),
    stars: int(a.stars),
    forkOf: str(a.forkOf),
    commits: { days30: int(a.commits?.days30), days90: int(a.commits?.days90), branch: str(a.commits?.branch) },
    mergedPullRequests: { days30: int(a.mergedPullRequests?.days30), days90: int(a.mergedPullRequests?.days90), atLeast: a.mergedPullRequests?.atLeast === true },
    openPullRequests: int(a.openPullRequests),
    issues: {
      open: int(issues.open),
      openedDays30: int(issues.openedDays30),
      openedAtLeast: issues.openedAtLeast === true,
      bug: int(issues.bug),
      critical: int(issues.critical),
      criticalLabels: Array.isArray(issues.criticalLabels)
        ? issues.criticalLabels.filter((l) => str(l?.name)).map((l) => ({ name: l.name, open: int(l.open) }))
        : [],
      countsExact: issues.countsExact === true
    },
    advisories: adv
      ? {
        total: int(adv.total),
        last365Days: int(adv.last365Days),
        bySeverity: Object.fromEntries(['critical', 'high', 'medium', 'low'].map((k) => [k, int(adv.bySeverity?.[k]) ?? 0])),
        latest: (Array.isArray(adv.latest) ? adv.latest : []).slice(0, 3).map((x) => ({
          id: str(x?.id), cve: str(x?.cve), severity: str(x?.severity), cvss: num(x?.cvss), publishedAt: iso(x?.publishedAt), summary: str(x?.summary), url: str(x?.url)
        }))
      }
      : null,
    level: level(a.level, ACTIVITY_LEVELS),
    attention: {
      level: level(a.attention?.level, ATTENTION_LEVELS),
      reasons: strList(a.attention?.reasons)
    }
  };
}

function normalizeNetwork(n) {
  return {
    chainId: n.chainId,
    name: str(n.name),
    kinds: strList(n.kinds),
    source: str(n.source)
  };
}

/**
 * One registry entry. `includeNetworks: false` keeps the per-chain list slim (a client like
 * geth serves hundreds of networks) while still saying how many through networkCount.
 */
export function normalizeClient(entry, { includeNetworks = true } = {}) {
  const networks = Array.isArray(entry?.networks)
    ? entry.networks.filter((n) => Number.isSafeInteger(n?.chainId)).map(normalizeNetwork)
    : null;
  const networkCount = Number.isSafeInteger(entry?.networkCount) ? entry.networkCount : (networks ? networks.length : null);
  // latestFork is a whole release item on /clients/:host/:owner/:repo (its fork under
  // enrichment.fork); accept a bare fork object too.
  const lf = entry?.latestFork;
  const latestFork = normalizeFork(lf?.enrichment?.fork ?? lf?.fork ?? lf);
  return {
    id: str(entry?.id),
    host: str(entry?.host),
    repo: str(entry?.repo),
    url: str(entry?.url),
    kinds: strList(entry?.kinds),
    names: strList(entry?.names),
    supported: typeof entry?.supported === 'boolean' ? entry.supported : null,
    pollStatus: str(entry?.pollStatus),
    role: str(entry?.role),
    networkCount,
    ...(includeNetworks ? { networks: networks ?? [] } : {}),
    latestRelease: normalizeLatestRelease(entry?.latestRelease, entry),
    latestFork,
    activity: normalizeActivity(entry?.activity)
  };
}

const LINEAGE_VIA = new Set(['github-fork', 'gitlab-fork', 'known', 'name']);
const MAX_LINEAGE_DOWNSTREAM = 200;

/**
 * The feed's client lineage: the upstream client this one customizes (host-recorded fork, or a
 * family its name gives) and, for an upstream, the clients customizing it with their networks.
 * `via` says which evidence each link rests on (host fork, known lineage, or name); `name` links
 * are hints, not facts.
 */
export function normalizeLineage(l) {
  if (!l || typeof l !== 'object') return null;
  const via = (v) => (LINEAGE_VIA.has(v) ? v : 'name');
  const upstream = Array.isArray(l.upstream)
    ? l.upstream.filter((u) => str(u?.repo)).slice(0, 10).map((u) => ({
      repo: u.repo, id: str(u.id), family: str(u.family), via: via(u.via), evidence: str(u.evidence)
    }))
    : [];
  const downstream = Array.isArray(l.downstream)
    ? l.downstream.filter((d) => str(d?.id) && str(d?.repo)).slice(0, MAX_LINEAGE_DOWNSTREAM).map((d) => ({
      id: d.id,
      repo: d.repo,
      names: strList(d.names).slice(0, 3),
      role: str(d.role),
      networkCount: int(d.networkCount) ?? 0,
      networks: Array.isArray(d.networks)
        ? d.networks.filter((n) => Number.isSafeInteger(n?.chainId)).slice(0, 10).map((n) => ({ chainId: n.chainId, name: str(n.name) }))
        : [],
      via: via(d.via)
    }))
    : [];
  return { family: str(l.family), upstream, downstream, downstreamTotal: int(l.downstreamTotal) ?? downstream.length };
}

// ─── reads ──────────────────────────────────────────────────────────────────

/**
 * The feed's own totals for a capped list. A legacy body without them (a bare array) is
 * reported as unknown (null), never as complete: `count` alone cannot tell a page from the whole.
 */
function completeness(body, count) {
  const totalMatched = Number.isSafeInteger(body?.totalMatched) ? body.totalMatched : null;
  const truncated = typeof body?.truncated === 'boolean' ? body.truncated : (totalMatched != null ? totalMatched > count : null);
  return { totalMatched, truncated };
}

/**
 * Client releases, newest first, filters passed through to the feed.
 * `since`/`until` bound publishedAt, both inclusive (a bare `until` date covers that day).
 * @param {{limit?: number, fork?: boolean, chainId?: number, repo?: string, since?: string, until?: string}} [options]
 */
export async function getClientReleases({ limit, fork, chainId, repo, since, until } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 100, MAX_RELEASE_LIMIT));
  const { body, fetchedAt, stale } = await cachedGet('/releases', {
    limit: capped,
    fork: typeof fork === 'boolean' ? String(fork) : undefined,
    chainId,
    // The feed matches its registry id (`github:owner/repo`, lowercase); a bare slug is GitHub.
    repo: repo ? (/^(github|gitlab):/i.test(repo) ? repo : `github:${repo}`).toLowerCase() : undefined,
    since,
    until
  });
  const items = listOf(body, 'items', 'releases').map(normalizeRelease);
  return { fetchedAt: new Date(fetchedAt).toISOString(), stale, ...completeness(body, items.length), count: items.length, items };
}

/** Registry entries matching a text/kind/chain filter. */
export async function getFeedClients({ q, kind, chainId, limit } = {}) {
  const { body, fetchedAt, stale } = await cachedGet('/clients', { q, kind, chainId, limit });
  const clients = listOf(body, 'clients', 'items', 'repositories').map((e) => normalizeClient(e, { includeNetworks: false }));
  return { fetchedAt: new Date(fetchedAt).toISOString(), stale, ...completeness(body, clients.length), count: clients.length, clients };
}

/**
 * One repository's registry entry with every network it serves (the reverse lookup).
 * host/owner/repo MUST already be validated by the caller; they are still URI-encoded here.
 */
export async function getFeedClient(host, owner, repo) {
  const path = `/clients/${encodeURIComponent(host)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let res;
  try {
    res = await cachedGet(path);
  } catch (err) {
    if (err instanceof ClientFeedNotFoundError) throw new ClientFeedNotFoundError('Client not found');
    throw err;
  }
  // The feed answers {client: entry, poll, latestRelease, latestFork}; the latest pair sits
  // beside the entry, not in it.
  const body = res.body ?? {};
  const entry = body.client ?? body.entry ?? body;
  const merged = {
    ...entry,
    latestRelease: body.latestRelease ?? entry?.latestRelease,
    latestFork: body.latestFork ?? entry?.latestFork,
    activity: body.activity ?? entry?.activity,
    pollStatus: body.poll?.status ?? entry?.pollStatus
  };
  return {
    fetchedAt: new Date(res.fetchedAt).toISOString(),
    stale: res.stale,
    // Null from a feed that predates lineage.
    client: { ...normalizeClient(merged), lineage: normalizeLineage(body.lineage) }
  };
}

/**
 * Clients serving one chain, each with the kinds it plays on THAT chain. Tolerates the feed
 * returning `{entry, network}` pairs or flattened entries.
 */
export async function getNetworkClients(chainId) {
  let res;
  try {
    res = await cachedGet(`/networks/${Number(chainId)}/clients`);
  } catch (err) {
    // An unknown chain is simply a chain with no clients on record.
    if (err instanceof ClientFeedNotFoundError) {
      return { fetchedAt: new Date().toISOString(), stale: false, chainId, count: 0, clients: [] };
    }
    throw err;
  }
  const clients = listOf(res.body, 'clients', 'items').map((it) => {
    const entry = it?.entry ?? it;
    const net = it?.network ?? (Array.isArray(entry?.networks) ? entry.networks.find((n) => n?.chainId === chainId) : null);
    const base = normalizeClient(entry, { includeNetworks: false });
    // A flattened row carries its per-chain source on the entry itself.
    return { ...base, kinds: strList(net?.kinds).length ? strList(net.kinds) : base.kinds, source: str(net?.source ?? (it?.entry ? null : it?.source)) };
  });
  return { fetchedAt: new Date(res.fetchedAt).toISOString(), stale: res.stale, chainId, name: str(res.body?.name), count: clients.length, clients };
}
