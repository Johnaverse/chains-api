import {
  DATA_SOURCE_THE_GRAPH,
  DATA_SOURCE_CHAINLIST,
  DATA_SOURCE_CHAINS,
  DATA_SOURCE_SLIP44
} from '../../config.js';
import { fetchData } from '../transport/fetch.js';
import { parseSLIP44 } from '../sources/slip44.js';
import { fetchL2Beat } from '../sources/l2beat.js';
import { fetchDefiLlama } from '../sources/defillama.js';
import { indexData } from '../store/indexer.js';
import { cachedData, applyDataToCache } from '../store/cache.js';
import { attachNetworkResearch } from '../sources/networkResearch.js';
import {
  readSnapshotFromDisk,
  writeSnapshotToDiskAtomic,
  DATA_CACHE_PATH
} from '../store/snapshot.js';
import { loadAllRpcHealthFromDisk } from '../store/rpcHealthStore.js';
import { logger } from '../util/logger.js';

const DATA_SOURCES = {
  theGraph: DATA_SOURCE_THE_GRAPH,
  chainlist: DATA_SOURCE_CHAINLIST,
  chains: DATA_SOURCE_CHAINS,
  slip44: DATA_SOURCE_SLIP44
};

let dataRefreshPromise = null;
let startupInitializationPromise = null;
let startupInitialized = false;

/**
 * Count how many of the three chain registries (theGraph, chainlist, chains)
 * loaded successfully. SLIP-0044 is excluded because it only contributes
 * coin-type metadata, not chain entries — if every chain registry fails but
 * SLIP-0044 succeeds, the API would otherwise come up with an empty index.
 * L2BEAT and DefiLlama are also excluded because they have their own static fallbacks.
 */
function countLoadedChainSources(data) {
  let loaded = 0;
  if (data.theGraph !== null) loaded++;
  if (data.chainlist !== null) loaded++;
  if (data.chains !== null) loaded++;
  return loaded;
}

async function fetchAndBuildData() {
  logger.info('Loading data from all sources');

  const results = await Promise.allSettled([
    fetchData(DATA_SOURCES.theGraph),
    fetchData(DATA_SOURCES.chainlist),
    fetchData(DATA_SOURCES.chains),
    fetchData(DATA_SOURCES.slip44, 'text'),
    fetchL2Beat(),
    fetchDefiLlama()
  ]);

  const theGraph = results[0].status === 'fulfilled' ? results[0].value : null;
  const chainlist = results[1].status === 'fulfilled' ? results[1].value : null;
  const chains = results[2].status === 'fulfilled' ? results[2].value : null;
  const slip44Text = results[3].status === 'fulfilled' ? results[3].value : null;
  const l2beat = results[4].status === 'fulfilled' ? results[4].value : null;
  const defillama = results[5].status === 'fulfilled' ? results[5].value : null;

  const sourceNames = ['theGraph', 'chainlist', 'chains', 'slip44', 'l2beat', 'defillama'];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.error({ source: sourceNames[i], err: result.reason?.message || result.reason }, 'Failed to load source');
    }
  });

  // Only parse SLIP-44 when fetch actually returned something; otherwise keep
  // null so /sources can distinguish "fetch failed" from "fetched, empty".
  const slip44 = slip44Text === null ? null : parseSLIP44(slip44Text);
  const indexed = indexData(theGraph, chainlist, chains, slip44, l2beat, defillama);

  return {
    data: {
      theGraph,
      chainlist,
      chains,
      slip44,
      l2beat,
      defillama,
      indexed,
      lastUpdated: new Date().toISOString(),
      rpcHealth: {},
      lastRpcCheck: null
    },
    loadedSourceCount: countLoadedChainSources({ theGraph, chainlist, chains })
  };
}

async function refreshDataWithGuard(options = {}) {
  const {
    requireAtLeastOneSource = false,
    logSuccessMessage = true,
    preserveRpcHealth = false
  } = options;

  if (dataRefreshPromise) return dataRefreshPromise;

  dataRefreshPromise = (async () => {
    const { data, loadedSourceCount } = await fetchAndBuildData();

    if (requireAtLeastOneSource && loadedSourceCount === 0) {
      throw new Error('All chain registry sources failed during data refresh');
    }

    // Background self-heal refreshes carry over the live RPC-health results so
    // re-fetching the registries (e.g. to recover a source that failed at boot)
    // doesn't wipe an in-progress monitoring sweep. The initial load has none.
    if (preserveRpcHealth) {
      data.rpcHealth = cachedData.rpcHealth;
      data.lastRpcCheck = cachedData.lastRpcCheck;
    }

    applyDataToCache(data);
    await writeSnapshotToDiskAtomic(cachedData);

    if (logSuccessMessage) {
      logger.info({ totalChains: cachedData.indexed.all.length }, 'Data loaded successfully');
    }

    return cachedData;
  })();

  try {
    return await dataRefreshPromise;
  } finally {
    dataRefreshPromise = null;
  }
}

export async function loadData() {
  return refreshDataWithGuard({ requireAtLeastOneSource: true });
}

/**
 * Names of core/supplementary registries whose fetch failed (value is null).
 * Used by the background self-healer to decide whether to re-fetch. Note this
 * checks fetch failure only — a SLIP-0044 that fetched but parsed to zero rows
 * ({}) is a data-format issue a re-fetch can't fix, so it is NOT listed here.
 * L2BEAT is excluded: it has its own fallback + rolling refresher.
 */
export function getFailedSources() {
  const failed = [];
  if (cachedData.theGraph == null) failed.push('theGraph');
  if (cachedData.chainlist == null) failed.push('chainlist');
  if (cachedData.chains == null) failed.push('chains');
  if (cachedData.slip44 == null) failed.push('slip44');
  return failed;
}

/**
 * Re-fetch all sources, preserving in-progress RPC-health results. Used by the
 * background self-healer (recovery from a transient boot-time fetch failure).
 */
export async function refreshAllSources() {
  return refreshDataWithGuard({
    requireAtLeastOneSource: true,
    logSuccessMessage: false,
    preserveRpcHealth: true
  });
}

/**
 * Overlay the per-chain RPC-health cache (written live by the rolling
 * refresher) onto the in-memory state, so on startup the server serves each
 * endpoint's last known status until the refresher re-tests it. The per-chain
 * store is authoritative over whatever rpcHealth rode along in the data
 * snapshot.
 */
async function overlayDiskRpcHealth() {
  const { byChainId, lastCheckedAt } = await loadAllRpcHealthFromDisk();
  if (Object.keys(byChainId).length === 0) return;
  cachedData.rpcHealth = byChainId;
  if (lastCheckedAt) cachedData.lastRpcCheck = lastCheckedAt;
  logger.info({ chains: Object.keys(byChainId).length }, 'Loaded cached RPC-health state');
}

/**
 * Stale-first startup:
 *  1. Load valid snapshot from disk if available.
 *  2. Trigger background refresh; keep serving stale data on failure.
 *  3. Fall back to a blocking load if no valid snapshot exists.
 */
export async function initializeDataOnStartup(options = {}) {
  const { onBackgroundRefreshSuccess } = options;

  if (startupInitialized) return cachedData;
  if (startupInitializationPromise) return startupInitializationPromise;

  startupInitializationPromise = (async () => {
    const snapshotData = await readSnapshotFromDisk();

    if (snapshotData) {
      applyDataToCache(snapshotData);
      // The snapshot was indexed by whatever version wrote it; the research dataset ships
      // with this build, so re-stamp it (idempotent) rather than serve a family-less index
      // until the background refresh lands. JSON serialisation split `all` from `byChainId`
      // into separate copies, so rebuild `all` the way indexData does or the list endpoints
      // (which read `all`) would miss the stamp.
      attachNetworkResearch(cachedData.indexed);
      cachedData.indexed.all = Object.values(cachedData.indexed.byChainId);
      await overlayDiskRpcHealth();
      startupInitialized = true;
      logger.info({ path: DATA_CACHE_PATH, totalChains: cachedData.indexed.all.length }, 'Loaded cached snapshot');

      // Preserve the RPC-health results loaded from disk: the server
      // serves the cached endpoint statuses immediately and the rolling
      // refresher replaces each chain's entry as it re-tests it. Without this
      // the post-boot data refresh would wipe the cached statuses.
      refreshDataWithGuard({ requireAtLeastOneSource: true, preserveRpcHealth: true })
        .then(() => {
          logger.info('Background refresh completed successfully');
          if (typeof onBackgroundRefreshSuccess === 'function') {
            onBackgroundRefreshSuccess();
          }
        })
        .catch(error => {
          logger.error({ err: error.message || error }, 'Background refresh failed; continuing with cached data');
        });

      return cachedData;
    }

    logger.info('No valid cache snapshot found. Loading data from remote sources');
    const loadedData = await loadData();
    await overlayDiskRpcHealth();
    startupInitialized = true;
    return loadedData;
  })();

  try {
    return await startupInitializationPromise;
  } finally {
    startupInitializationPromise = null;
  }
}
