import {
  LIVE_INCIDENTS_URL,
  LIVE_INCIDENTS_FETCH_TIMEOUT_MS,
  FORUM_NEWS_URL,
  FORUM_NEWS_FETCH_TIMEOUT_MS,
  WEB3_NEWS_URL,
  WEB3_NEWS_FETCH_TIMEOUT_MS,
  LIVE_INCIDENTS_CACHE_TTL_MS
} from '../../config.js';
import { getFeed } from './feedHttp.js';
import { logger } from '../util/logger.js';
import { slimFork } from '../domain/forks.js';

/**
 * Every fork mention across the three feed services, in one shape.
 *
 * Forks used to come from the status feed alone, which missed most of them: Ethereum has no
 * status page, so Glamsterdam — announced on the EF blog (chains-news), discussed on the
 * Ethereum and Arbitrum forums (chains-forum-news), covered by CoinDesk — never reached
 * get_forks. All three services now extract the same `enrichment.fork` object, so a fork is
 * grouped across a status window, a forum post and an article alike.
 *
 * Fetched with `?fork=true`, not from the tools' recent-items caches: those hold the newest
 * few hundred items, and a fork is announced weeks ahead — on the status feed, 389 duplicate
 * B3 events were enough to push a month of history out of the window.
 */

const FETCH_LIMIT = 500;

const FEEDS = [
  { kind: 'status', base: () => LIVE_INCIDENTS_URL, path: '/events', listKey: 'events', timeout: () => LIVE_INCIDENTS_FETCH_TIMEOUT_MS },
  { kind: 'forum', base: () => FORUM_NEWS_URL, path: '/news', listKey: 'news', timeout: () => FORUM_NEWS_FETCH_TIMEOUT_MS },
  { kind: 'news', base: () => WEB3_NEWS_URL, path: '/news', listKey: 'news', timeout: () => WEB3_NEWS_FETCH_TIMEOUT_MS }
];

let cache = { fetchedAt: 0, failedAt: 0, mentions: null, feeds: {} };
let inflight = null;

// After a full outage, how long the last good set is served without asking again. Each round
// is up to six requests that can each wait out the full timeout, and without this every
// get_forks call during the outage paid for all of them.
const FAILURE_BACKOFF_MS = 30_000;

export function _resetForkFeedsForTests() {
  cache = { fetchedAt: 0, failedAt: 0, mentions: null, feeds: {} };
  inflight = null;
}

/**
 * Fork mentions from all feeds, newest cache within the live-incident TTL.
 *
 * Concurrent callers on a cache miss share one fetch round: the assistant can issue several
 * tool calls at once, and each used to fan out to every feed on its own.
 *
 * @returns {Promise<{fetchedAt: string|null, feeds: object, mentions: object[]}>} `feeds` says,
 *   per feed, whether it answered THIS round (`ok`) and, when it did not, whether its items are
 *   left over from an earlier one (`stale`) — a fork list missing a whole feed must say so.
 */
export async function getForkMentions() {
  const now = Date.now();
  if (cache.mentions && now - cache.fetchedAt < LIVE_INCIDENTS_CACHE_TTL_MS) return snapshot();
  if (cache.mentions && now - cache.failedAt < FAILURE_BACKOFF_MS) return snapshot();
  inflight ??= refresh().finally(() => { inflight = null; });
  return inflight;
}

async function refresh() {
  const results = await Promise.all(FEEDS.map(async (feed) => {
    try {
      return { feed, items: await fetchFeed(feed) };
    } catch (err) {
      logger.warn({ feed: feed.kind, err: err.message }, 'fork feed unavailable');
      return { feed, error: err.message };
    }
  }));
  const answered = results.filter((r) => r.items);
  if (answered.length === 0 && cache.mentions) {
    // Serve the last good set, but never with the flags of the round that produced it: every
    // feed failed, and `ok: true` would tell the assistant the stale list is complete.
    cache = {
      ...cache,
      failedAt: Date.now(),
      feeds: Object.fromEntries(Object.entries(cache.feeds).map(([k, v]) => [k, { ...v, ok: false, stale: Boolean(v.items) }]))
    };
    return snapshot();
  }
  if (answered.length === 0) throw new Error(`Fork feeds unavailable: ${results.map((r) => `${r.feed.kind}: ${r.error}`).join('; ')}`);

  const previous = cache.feeds;
  const feeds = {};
  const mentions = [];
  for (const r of results) {
    // A feed that failed THIS time keeps its last good items rather than silently vanishing.
    const items = r.items ?? previous[r.feed.kind]?.items ?? null;
    feeds[r.feed.kind] = { ok: Boolean(r.items), stale: !r.items && Boolean(items), items };
    for (const it of items ?? []) {
      const mention = toMention(r.feed.kind, it);
      if (mention) mentions.push(mention);
    }
  }
  cache = { fetchedAt: Date.now(), failedAt: 0, mentions, feeds };
  return snapshot();
}

function snapshot() {
  return {
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    feeds: Object.fromEntries(Object.entries(cache.feeds).map(([k, v]) => [k, {
      ok: v.ok, ...(v.stale ? { stale: true } : {}), count: v.items?.length ?? 0
    }])),
    mentions: cache.mentions ?? []
  };
}

async function fetchFeed(feed) {
  const url = `${feed.base()}${feed.path}?limit=${FETCH_LIMIT}`;
  const get = (u) => getFeed(u, feed.timeout());
  let response = await get(`${url}&fork=true`);
  // The feeds reject unknown query keys with 400, and `fork` is newer than some deployments:
  // fall back to the unfiltered window and filter here, which is what the param saves.
  if (response.status === 400) response = await get(url);
  if (!response.ok) throw new Error(`responded ${response.status}`);
  const body = await response.json();
  const list = Array.isArray(body?.[feed.listKey]) ? body[feed.listKey] : [];
  return list.filter((it) => it?.enrichment?.fork && typeof it.enrichment.fork === 'object');
}

/**
 * One feed item -> the event shape src/domain/forks.js groups. `source` is the status page,
 * forum or publication; `feed` says which kind, because a secondary news outlet's date is
 * weaker evidence than the network's own announcement.
 */
export function toMention(kind, it) {
  const fork = slimFork(it?.enrichment?.fork);
  if (!fork) return null;
  const enrichment = it.enrichment;
  const source = kind === 'status' ? it.statusPage : kind === 'forum' ? it.forum : it.source;
  const strings = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string') : []);
  return {
    feed: kind,
    title: it.title || '(untitled)',
    url: it.url || null,
    publishedAt: it.publishedAt ?? null,
    updatedAt: it.updatedAt ?? null,
    status: it.status ?? null,
    chains: (it.chains ?? []).filter((c) => Number.isFinite(c?.chainId)).map((c) => ({ chainId: c.chainId })),
    statusPage: { id: source?.id ?? null, name: source?.name ?? null, kind: kind === 'status' ? (source?.kind ?? null) : kind },
    // Only chains-news grades its outlets (primary = the project's own channel).
    weight: kind === 'news' ? (source?.weight ?? null) : null,
    enrichment: {
      class: enrichment.class ?? null,
      // chains-news names them chainNames; the other two affectedChains.
      affectedChains: strings(enrichment.affectedChains ?? enrichment.chainNames),
      chains: (enrichment.chains ?? []).filter((id) => Number.isFinite(id)),
      fork
    }
  };
}
