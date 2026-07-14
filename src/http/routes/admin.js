import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { getCachedData } from '../../store/cache.js';
import {
  getAllChains,
  getRpcMonitoringResults,
  countChainsByTag
} from '../../store/queries.js';
import { getAllKeywords } from '../../domain/keywords.js';
import { loadData } from '../../services/loader.js';
import { startRpcHealthCheck, getRpcMonitoringStatus } from '../../services/rpcHealth.js';
import { validateChainData } from '../../services/validation.js';
import { getL2BeatRefreshStatus } from '../../services/l2beatRefresher.js';
import {
  RELOAD_RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  DATA_CACHE_ENABLED,
  DATA_CACHE_FILE,
  L2BEAT_STALE_AFTER_MS,
  ASSISTANT_ENABLED,
  ASSISTANT_MODEL
} from '../../../config.js';
import { sendError } from '../util/sendError.js';

function ageSeconds(isoTimestamp) {
  if (!isoTimestamp) return null;
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 1000);
}

// SLIP-0044 only counts as loaded when it actually parsed rows: null = fetch
// failed, {} = fetched but parsed nothing (e.g. upstream table format drift).
// Both surface as "not loaded" so a silently empty registry stays visible.
function slip44Loaded(cache) {
  return cache.slip44 != null && Object.keys(cache.slip44).length > 0;
}

function sourceFreshness(cache) {
  const dataAge = ageSeconds(cache.lastUpdated);
  const hasL2Beat = cache.l2beat != null
    && Array.isArray(cache.l2beat.projects)
    && cache.l2beat.projects.length > 0;
  const hasSlip44 = slip44Loaded(cache);
  return {
    theGraph: { loaded: cache.theGraph != null, ageSeconds: cache.theGraph != null ? dataAge : null },
    chainlist: { loaded: cache.chainlist != null, ageSeconds: cache.chainlist != null ? dataAge : null },
    chains: { loaded: cache.chains != null, ageSeconds: cache.chains != null ? dataAge : null },
    slip44: { loaded: hasSlip44, ageSeconds: hasSlip44 ? dataAge : null },
    l2beat: {
      loaded: hasL2Beat,
      ageSeconds: ageSeconds(cache.l2beat?.fetchedAt),
      source: cache.l2beat?.source ?? null
    }
  };
}

function deriveOverallStatus(sources, refreshers) {
  const coreSources = ['theGraph', 'chainlist', 'chains'];
  const coreLoaded = coreSources.every(s => sources[s].loaded);
  if (!coreLoaded) return 'down';

  // Supplementary data is "degraded" only when it's entirely absent. L2BEAT
  // serving its static fallback (source: 'fallback') is graceful degradation,
  // not a failure — the data is present and usable — so it does NOT degrade
  // overall status; the per-source `source` field still surfaces it.
  const supplementaryDegraded = !sources.slip44.loaded || !sources.l2beat.loaded;
  const rpcStale = refreshers.rpc.lastRunAt &&
    ageSeconds(refreshers.rpc.lastRunAt) > 30 * 60; // > 30 min
  // L2BEAT refreshes once per full rolling sweep (tens of minutes for ~3k
  // chains), so it's only "stale" when a genuinely stuck refresher leaves it
  // un-refreshed for far longer than a normal sweep — see L2BEAT_STALE_AFTER_MS.
  const l2beatStale = refreshers.l2beat.lastRefreshAt &&
    ageSeconds(refreshers.l2beat.lastRefreshAt) > L2BEAT_STALE_AFTER_MS / 1000;

  if (supplementaryDegraded || rpcStale || l2beatStale) return 'degraded';
  return 'ok';
}

export async function adminRoutes(fastify) {
  fastify.get('/health', async () => {
    const cachedData = getCachedData();
    const sources = sourceFreshness(cachedData);
    const rpcStatus = getRpcMonitoringStatus();
    const l2beatStatus = getL2BeatRefreshStatus();
    const refreshers = {
      rpc: {
        isRunning: rpcStatus.isMonitoring,
        lastRunAt: rpcStatus.lastUpdated
      },
      l2beat: l2beatStatus
    };

    return {
      status: deriveOverallStatus(sources, refreshers),
      dataLoaded: cachedData.indexed !== null,
      lastUpdated: cachedData.lastUpdated,
      totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0,
      sources,
      refreshers,
      // Only advertised when configured; an unreachable local LLM must not
      // degrade the data API's overall status, so it stays out of
      // deriveOverallStatus and the key is omitted entirely when disabled.
      ...(ASSISTANT_ENABLED ? { assistant: { enabled: true, model: ASSISTANT_MODEL } } : {})
    };
  });

  fastify.get('/sources', async () => {
    const cachedData = getCachedData();
    return {
      lastUpdated: cachedData.lastUpdated,
      sources: {
        theGraph: cachedData.theGraph ? 'loaded' : 'not loaded',
        chainlist: cachedData.chainlist ? 'loaded' : 'not loaded',
        chains: cachedData.chains ? 'loaded' : 'not loaded',
        slip44: slip44Loaded(cachedData) ? 'loaded' : 'not loaded',
        l2beat: cachedData.l2beat?.projects?.length > 0 ? 'loaded' : 'not loaded'
      }
    };
  });

  fastify.get('/export', {
    config: {
      rateLimit: {
        max: RELOAD_RATE_LIMIT_MAX,
        timeWindow: RATE_LIMIT_WINDOW_MS
      }
    }
  }, async (request, reply) => {
    if (!DATA_CACHE_ENABLED) {
      return sendError(reply, 503, 'Data cache export is disabled');
    }

    const filePath = resolve(DATA_CACHE_FILE);

    try {
      // ETag keyed on file identity (mtime+size) — hashing the multi-MB body
      // per request would defeat the point. Unchanged snapshots revalidate as
      // 304 without reading the file at all.
      const { mtimeMs, size } = await stat(filePath);
      const etag = `"${createHash('sha1').update(`${mtimeMs}:${size}`).digest('hex')}"`;
      reply.header('ETag', etag);
      reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      const raw = await readFile(filePath, 'utf8');
      JSON.parse(raw); // validate before serving; corrupt cache → 500 below

      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${basename(filePath)}"`);
      // Send the raw bytes — re-serializing the parsed object would double
      // the CPU cost of every request for an identical body.
      return reply.send(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return sendError(reply, 404, 'Export file not found');
      }

      if (error instanceof SyntaxError) {
        return sendError(reply, 500, 'Export file is not valid JSON');
      }

      fastify.log.error(error, 'Failed to export cache file');
      return sendError(reply, 500, 'Failed to export cache file');
    }
  });

  fastify.post('/reload', {
    config: {
      rateLimit: {
        max: RELOAD_RATE_LIMIT_MAX,
        timeWindow: RATE_LIMIT_WINDOW_MS
      }
    }
  }, async (_request, reply) => {
    try {
      await loadData();
      startRpcHealthCheck();
      const cachedData = getCachedData();
      return {
        status: 'success',
        lastUpdated: cachedData.lastUpdated,
        totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
      };
    } catch (error) {
      fastify.log.error(error, 'Failed to reload data');
      return sendError(reply, 500, 'Failed to reload data');
    }
  });

  fastify.get('/validate', async (_request, reply) => {
    const validationResults = validateChainData();
    if (validationResults.error) {
      return sendError(reply, 503, validationResults.error);
    }
    return validationResults;
  });

  fastify.get('/keywords', async () => {
    const keywordResults = getAllKeywords();
    const cachedData = getCachedData();
    return { lastUpdated: cachedData.lastUpdated, ...keywordResults };
  });

  fastify.get('/stats', async () => {
    const chains = getAllChains();
    const monitorResults = getRpcMonitoringResults();

    const { totalChains, totalMainnets, totalTestnets, totalL2s, totalBeacons, byStatus, activeChains, deprecatedChains } = countChainsByTag(chains);

    const rpcWorking = monitorResults.workingEndpoints;
    const rpcFailed = monitorResults.failedEndpoints || 0;
    const rpcTested = monitorResults.testedEndpoints;
    const rpcHealthPercent = rpcTested > 0
      ? Math.round((rpcWorking / rpcTested) * 10000) / 100
      : null;

    return {
      totalChains,
      totalMainnets,
      totalTestnets,
      totalL2s,
      totalBeacons,
      activeChains,
      deprecatedChains,
      byStatus,
      rpc: {
        totalEndpoints: monitorResults.totalEndpoints,
        tested: rpcTested,
        working: rpcWorking,
        failed: rpcFailed,
        healthPercent: rpcHealthPercent
      },
      lastUpdated: monitorResults.lastUpdated
    };
  });
}
