/**
 * Backwards-compatible facade. Implementation lives under src/.
 *
 * **New code should import directly from the per-domain modules under src/**
 * (e.g. `src/store/queries.js`, `src/services/loader.js`). This file exists
 * to keep existing imports — including external consumers, MCP tooling, and
 * the integration test mocks — working while the codebase migrates.
 *
 * Do not add new exports here. When a new function is added to src/, callers
 * should import it from its real location.
 */

export { fetchData } from './src/transport/fetch.js';
export { parseSLIP44 } from './src/sources/slip44.js';
export { indexData } from './src/store/indexer.js';
export { getCachedData } from './src/store/cache.js';
export {
  searchChains,
  getChainById,
  getChainDetail,
  getAllChains,
  countChainsByTag,
  getEndpointsById,
  getAllEndpoints,
  getRpcMonitoringResults
} from './src/store/queries.js';
export {
  runRpcHealthCheck,
  startRpcHealthCheck,
  getRpcMonitoringStatus
} from './src/services/rpcHealth.js';
export { getAllKeywords } from './src/domain/keywords.js';
export {
  getAllRelations,
  getRelationsById,
  traverseRelations
} from './src/domain/relations.js';
export { validateChainData } from './src/services/validation.js';
export { loadData, initializeDataOnStartup } from './src/services/loader.js';
