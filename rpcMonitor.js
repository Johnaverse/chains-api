import { getAllEndpoints } from './dataService.js';
import { MAX_ENDPOINTS_PER_CHAIN, RPC_CHECK_CONCURRENCY } from './config.js';
import { jsonRpcCall } from './rpcUtil.js';

// Store monitoring results in memory
let monitoringResults = {
  lastUpdated: null,
  totalEndpoints: 0,
  testedEndpoints: 0,
  workingEndpoints: 0,
  failedEndpoints: 0,
  results: []
};

// Flag to track if monitoring is running
let isMonitoring = false;

// Promise to track ongoing monitoring operation
let monitoringPromise = null;

/**
 * Extract URL from RPC endpoint (can be string or object)
 */
function extractUrl(rpcEndpoint) {
  if (typeof rpcEndpoint === 'string') {
    return rpcEndpoint;
  } else if (typeof rpcEndpoint === 'object' && rpcEndpoint.url) {
    return rpcEndpoint.url;
  }
  return null;
}

/**
 * Filter out invalid/template URLs
 */
function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  // Skip URLs with template variables
  if (url.includes('${') || url.includes('{') || url.includes('API_KEY')) {
    return false;
  }
  
  // Skip WebSocket URLs for now (we're testing HTTP RPC)
  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    return false;
  }
  
  // Only test HTTP/HTTPS URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }
  
  return true;
}

/**
 * Test a single RPC endpoint
 */
async function testRpcEndpoint(url) {
  const result = {
    url: url,
    status: 'unknown',
    clientVersion: null,
    blockNumber: null,
    latencyMs: null,
    error: null,
    testedAt: new Date().toISOString()
  };

  const start = Date.now();

  try {
    // Get client version
    try {
      const clientVersion = await jsonRpcCall(url, 'web3_clientVersion');
      result.clientVersion = clientVersion;
    } catch (clientVersionError) {
      console.debug(`web3_clientVersion not supported for ${url}: ${clientVersionError.message}`);
      result.clientVersion = 'unavailable';
    }

    // Get latest block number
    const blockNumberHex = await jsonRpcCall(url, 'eth_blockNumber');

    // Convert hex to decimal with validation
    if (!blockNumberHex || typeof blockNumberHex !== 'string') {
      throw new Error('Invalid block number response');
    }

    const blockNumber = Number.parseInt(blockNumberHex, 16);

    if (Number.isNaN(blockNumber)) {
      throw new TypeError('Failed to parse block number');
    }

    result.blockNumber = blockNumber;
    result.latencyMs = Date.now() - start;
    result.status = 'working';
  } catch (error) {
    result.latencyMs = Date.now() - start;
    result.status = 'failed';
    result.error = error.message;
  }

  return result;
}

/**
 * Record an endpoint result (working or failed) and update counters
 */
function recordEndpointResult(testResult, chainId, name, counters) {
  if (testResult.status === 'working') {
    counters.working++;
  } else {
    counters.failed++;
  }

  monitoringResults.results.push({ chainId, chainName: name, ...testResult });
  monitoringResults.lastUpdated = new Date().toISOString();
  monitoringResults.totalEndpoints = counters.total;
  monitoringResults.testedEndpoints = counters.tested;
  monitoringResults.workingEndpoints = counters.working;
  monitoringResults.failedEndpoints = counters.failed;

  if (counters.tested % 50 === 0) {
    console.log(`Tested ${counters.tested} endpoints, ${counters.working} working, ${counters.failed} failed...`);
  }
}

/**
 * Test all RPC endpoints for a single chain
 */
async function testChainEndpoints(chainEndpoints, counters) {
  const { chainId, name, rpc } = chainEndpoints;

  if (!rpc || rpc.length === 0) return;

  let chainTestedCount = 0;

  for (const rpcEndpoint of rpc) {
    const url = extractUrl(rpcEndpoint);
    counters.total++;

    if (!isValidUrl(url) || chainTestedCount >= MAX_ENDPOINTS_PER_CHAIN) {
      continue;
    }

    counters.tested++;
    chainTestedCount++;

    try {
      const testResult = await testRpcEndpoint(url);
      recordEndpointResult(testResult, chainId, name, counters);
    } catch (error) {
      console.error(`Error testing ${url}:`, error.message);
    }
  }
}

/**
 * Test all RPC endpoints for all chains with concurrency
 */
async function testAllEndpoints() {
  console.log(`Starting RPC endpoint monitoring (concurrency: ${RPC_CHECK_CONCURRENCY})...`);

  const allEndpoints = getAllEndpoints();
  const counters = { total: 0, tested: 0, working: 0, failed: 0 };

  monitoringResults = {
    lastUpdated: new Date().toISOString(),
    totalEndpoints: 0,
    testedEndpoints: 0,
    workingEndpoints: 0,
    failedEndpoints: 0,
    results: []
  };

  // Process chains concurrently in batches
  for (let i = 0; i < allEndpoints.length; i += RPC_CHECK_CONCURRENCY) {
    const batch = allEndpoints.slice(i, i + RPC_CHECK_CONCURRENCY);
    await Promise.allSettled(
      batch.map(chainEndpoints => testChainEndpoints(chainEndpoints, counters))
    );
  }

  console.log(`RPC monitoring completed. Tested ${counters.tested}/${counters.total} endpoints, ${counters.working} working, ${counters.failed} failed.`);

  return monitoringResults;
}

/**
 * Start monitoring. Loops continuously if RPC_MONITOR_LOOP=true, otherwise runs once.
 */
export async function startMonitoring() {
  const loop = process.env.RPC_MONITOR_LOOP === 'true';

  // If monitoring is already in progress, return the existing promise
  if (monitoringPromise) {
    console.log('Monitoring already in progress, returning existing operation...');
    return monitoringPromise;
  }

  // Create and store the monitoring promise
  monitoringPromise = (async () => {
    isMonitoring = true;

    while (true) {
      try {
        await testAllEndpoints();
      } catch (error) {
        console.error('Error during RPC monitoring:', error);
      }
      if (!loop) break;
      console.log('RPC monitoring cycle complete. Restarting...');
    }
  })();

  // Reset state when monitoring completes (even on error)
  monitoringPromise.finally(() => {
    isMonitoring = false;
    monitoringPromise = null;
  });

  return monitoringPromise;
}

/**
 * Get current monitoring results
 */
export function getMonitoringResults() {
  return monitoringResults;
}

/**
 * Get monitoring status
 */
export function getMonitoringStatus() {
  return {
    isMonitoring,
    lastUpdated: monitoringResults.lastUpdated
  };
}

/**
 * Start RPC health check without blocking
 * This is a non-blocking wrapper around startMonitoring()
 */
export function startRpcHealthCheck() {
  startMonitoring().catch(error => {
    console.error('Failed to start RPC health check:', error);
  });
}
