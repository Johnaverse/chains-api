import { LIVE_INCIDENTS_URL, LIVE_INCIDENTS_FETCH_TIMEOUT_MS } from '../../config.js';
import { proxyFetch } from '../../fetchUtil.js';
import { logger } from '../util/logger.js';

/**
 * The status-news feed's /status-pages catalog (chains-status-news). Distinct
 * from OUR /status-pages route (data/status-pages.json): this is the upstream
 * feed's own registry, and its rpc-provider entries MAY carry a `coverage`
 * object ({chainsListed, chainIdsResolved, componentCount}) describing what
 * the provider's status page itself claims to cover. Deployed feeds predate
 * that field — every consumer must tolerate its absence.
 *
 * The catalog changes rarely (it is the feed's static config), so a 10-minute
 * cache is plenty and keeps provider-stats calls from hammering the upstream.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

let cache = { fetchedAt: 0, pages: null };

export function _resetStatusNewsPagesCacheForTests() {
  cache = { fetchedAt: 0, pages: null };
}

/**
 * @returns {Promise<object[]>} the feed's status-page entries; [] when the
 *   upstream is unreachable and nothing is cached (the caller can still build
 *   provider stats from the event stream alone).
 */
export async function getStatusNewsPages() {
  if (cache.pages && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.pages;
  try {
    const response = await proxyFetch(`${LIVE_INCIDENTS_URL}/status-pages`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LIVE_INCIDENTS_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Feed responded ${response.status}`);
    const body = await response.json();
    const pages = Array.isArray(body?.statusPages) ? body.statusPages : [];
    cache = { fetchedAt: Date.now(), pages };
    return pages;
  } catch (err) {
    // Supplementary source: stale beats empty, empty beats failing the caller.
    logger.warn({ err: err.message }, 'status-news /status-pages fetch failed');
    return cache.pages ?? [];
  }
}
