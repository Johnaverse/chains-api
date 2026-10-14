import { proxyFetch } from '../../fetchUtil.js';

/**
 * GET a feed service's JSON endpoint. One place for the request shape every feed consumer
 * sends (accept header, per-feed timeout), so the incident and fork paths cannot drift apart.
 */
export function getFeed(url, timeoutMs) {
  return proxyFetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
}
