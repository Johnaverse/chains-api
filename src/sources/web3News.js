import {
  WEB3_NEWS_URL,
  WEB3_NEWS_CACHE_TTL_MS,
  WEB3_NEWS_FETCH_TIMEOUT_MS
} from '../../config.js';
import { proxyFetch } from '../../fetchUtil.js';
import { logger } from '../util/logger.js';

/**
 * Ecosystem/editorial news feed (chains-news). Distinct from the other two feeds:
 * chains-status-news carries incidents, chains-forum-news carries governance discussion,
 * and this carries what the ecosystem publishes about itself (protocol blogs, research,
 * news desks).
 *
 * REST-only with a short in-memory cache: unlike forumNews this does not hold a WebSocket
 * open, because news arrives on a 5-minute cadence and a tool call every few minutes does
 * not justify a persistent socket per process.
 */

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 15;
// Ask for a broad superset so client-side filtering has something to work with; the
// upstream caps at 500 anyway.
const FEED_FETCH_LIMIT = 200;
const MAX_SUMMARY_CHARS = 280;

let cache = { fetchedAt: 0, items: null };

export function _resetWeb3NewsCacheForTests() {
  cache = { fetchedAt: 0, items: null };
}

/**
 * Fetch recent ecosystem news, optionally filtered.
 *
 * @param {object} [options]
 * @param {number} [options.chainId] only posts mapped to this chain
 * @param {string} [options.sourceId] only posts from this source id (e.g. "coindesk")
 * @param {'primary'|'secondary'} [options.weight] primary = protocol/research publishing,
 *   secondary = news desks whose output includes market coverage
 * @param {number} [options.limit] max posts returned (default 15, max 50)
 * @returns {Promise<{fetchedAt: string, count: number, totalMatched: number, news: object[]}>}
 * @throws when the feed is unreachable and no cached data exists
 */
export async function getWeb3News({ chainId, sourceId, weight, limit = DEFAULT_LIMIT } = {}) {
  const items = await loadNews();
  let filtered = items;
  if (chainId != null) filtered = filtered.filter((it) => it.chains.some((c) => c.chainId === chainId));
  if (sourceId) {
    const id = String(sourceId).toLowerCase();
    filtered = filtered.filter((it) => it.source.id?.toLowerCase() === id);
  }
  if (weight) filtered = filtered.filter((it) => it.source.weight === weight);
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const sliced = filtered.slice(0, capped);
  return {
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    count: sliced.length,
    totalMatched: filtered.length,
    news: sliced
  };
}

async function loadNews() {
  if (cache.items && Date.now() - cache.fetchedAt < WEB3_NEWS_CACHE_TTL_MS) {
    return cache.items;
  }
  try {
    const response = await proxyFetch(`${WEB3_NEWS_URL}/news?limit=${FEED_FETCH_LIMIT}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(WEB3_NEWS_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Feed responded ${response.status}`);
    const body = await response.json();
    const news = Array.isArray(body?.news) ? body.news : [];
    cache = { fetchedAt: Date.now(), items: normalizeItems(news) };
    return cache.items;
  } catch (err) {
    // Stale-but-present beats an error: news is supplementary context, so a blip upstream
    // should not fail a tool call that can still be answered.
    if (cache.items) {
      logger.warn({ err: err.message }, 'Web3 news feed fetch failed; serving stale cache');
      return cache.items;
    }
    throw new Error(`Web3 news feed unavailable: ${err.message}`);
  }
}

/**
 * Trim upstream items to a token-cheap shape. The feed already dedupes by id and returns
 * newest-first, so this only projects fields and re-sorts defensively.
 */
function normalizeItems(news) {
  return news
    .map((it) => {
      const publishedMs = Date.parse(it.publishedAt ?? it.updatedAt ?? '');
      return {
        title: it.title || '(untitled)',
        url: it.url || null,
        publishedAt: it.publishedAt ?? null,
        publishedMs: Number.isNaN(publishedMs) ? null : publishedMs,
        summary: typeof it.summary === 'string' && it.summary
          ? it.summary.slice(0, MAX_SUMMARY_CHARS)
          : null,
        source: {
          id: it.source?.id ?? null,
          name: it.source?.name ?? null,
          // primary vs secondary lets the assistant prefer protocol announcements over
          // market commentary when both mention the same chain.
          weight: it.source?.weight ?? null
        },
        chains: Array.isArray(it.chains)
          ? it.chains.filter((c) => c?.chainId != null).map((c) => ({ chainId: c.chainId, name: c.name ?? null }))
          : []
      };
    })
    .sort((a, b) => (b.publishedMs ?? 0) - (a.publishedMs ?? 0));
}
