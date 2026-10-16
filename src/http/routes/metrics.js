import { getCachedData } from '../../store/cache.js';
import { getRpcMonitoringStatus } from '../../services/rpcHealth.js';
import { validateChainData } from '../../services/validation.js';
import { getL2BeatRefreshStatus } from '../../services/l2beatRefresher.js';
import { renderMetrics } from '../../util/metrics.js';
import { getLastIncidentSentinelSummary } from '../../services/incidentSentinel.js';

/**
 * GET /metrics — Prometheus exposition format. Scrape this endpoint to
 * monitor source freshness, refresh outcomes, RPC checks, and validation
 * error counts. Mounted as text/plain so existing scrapers parse it
 * without configuration.
 *
 * Validation is O(N chains × M rules) and would dominate /metrics latency
 * if recomputed on every scrape. Cache the result for VALIDATION_CACHE_MS
 * (default 30s) — well under Prometheus' default 15s scrape interval and
 * the chain refresh cadence, so freshness loss is negligible.
 */
const VALIDATION_CACHE_MS = 30_000;
let validationCache = { summary: null, computedAt: 0 };

function cachedValidationSummary() {
  const now = Date.now();
  if (now - validationCache.computedAt < VALIDATION_CACHE_MS) {
    return validationCache.summary;
  }
  try {
    const report = validateChainData();
    validationCache = {
      summary: report.error ? null : report.summary,
      computedAt: now
    };
  } catch {
    validationCache = { summary: null, computedAt: now };
  }
  return validationCache.summary;
}

// Test-only helper.
export function _resetMetricsValidationCacheForTests() {
  validationCache = { summary: null, computedAt: 0 };
}

export async function metricsRoute(fastify) {
  fastify.get('/metrics', async (_request, reply) => {
    const cache = getCachedData();
    const rpcStatus = getRpcMonitoringStatus();
    const l2beatStatus = getL2BeatRefreshStatus();
    const validationSummary = cachedValidationSummary();
    // Read-only: never runs the sentinel, so a scrape cannot block on the incident feed.
    const incidentSummary = getLastIncidentSentinelSummary();

    const body = renderMetrics({ cache, rpcStatus, l2beatStatus, validationSummary, incidentSummary });
    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return body;
  });
}
