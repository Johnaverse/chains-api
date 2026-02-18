import { getAllEndpoints } from './dataService.js';
import { MAX_ENDPOINTS_PER_CHAIN } from './config.js';
import { jsonRpcCall } from './rpcUtil.js';

// Store monitoring results in memory
let monitoringResults = {
  lastUpdated: null,
  totalEndpoints: 0,
  testedEndpoints: 0,
  workingEndpoints: 0,
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
    error: null,
    testedAt: new Date().toISOString()
  };
  
  try {
    // Get client version
    try {
      const clientVersion = await jsonRpcCall(url, 'web3_clientVersion');
      result.clientVersion = clientVersion;
    } catch (error) {
      // Some RPC endpoints might not support web3_clientVersion, continue anyway
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
      throw new Error('Failed to parse block number');
    }
    
    result.blockNumber = blockNumber;
    
    result.status = 'working';
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
  }
  
  return result;
}

/**
 * Test all RPC endpoints for all chains
 */
async function testAllEndpoints() {
  console.log('Starting RPC endpoint monitoring...');

  const allEndpoints = getAllEndpoints();
  let totalEndpoints = 0;
  let testedEndpoints = 0;
  let workingEndpoints = 0;

  // Initialize monitoring results at the start
  monitoringResults = {
    lastUpdated: new Date().toISOString(),
    totalEndpoints: 0,
    testedEndpoints: 0,
    workingEndpoints: 0,
    results: []
  };

  // Limit testing per chain (from config)

  for (const chainEndpoints of allEndpoints) {
    const { chainId, name, rpc } = chainEndpoints;

    if (!rpc || rpc.length === 0) {
      continue;
    }

    let chainTestedCount = 0;
    let foundFailedEndpoint = false; // Track if we've encountered a failed endpoint

    for (const rpcEndpoint of rpc) {
      const url = extractUrl(rpcEndpoint);
      totalEndpoints++;

      if (!isValidUrl(url)) {
        continue;
      }

      // Skip if we've already tested enough endpoints for this chain
      if (chainTestedCount >= MAX_ENDPOINTS_PER_CHAIN) {
        continue;
      }

      // Stop testing additional endpoints for this chain if we already found one that failed
      if (foundFailedEndpoint) {
        continue;
      }

      testedEndpoints++;
      chainTestedCount++;

      try {
        const testResult = await testRpcEndpoint(url);

        if (testResult.status === 'working') {
          workingEndpoints++;

          // Only add working endpoints to results
          monitoringResults.results.push({
            chainId,
            chainName: name,
            ...testResult
          });
        } else if (testResult.status === 'failed') {
          // Mark that we found a failed endpoint for this chain
          foundFailedEndpoint = true;
        }

        // Update monitoring status in real-time
        monitoringResults.lastUpdated = new Date().toISOString();
        monitoringResults.totalEndpoints = totalEndpoints;
        monitoringResults.testedEndpoints = testedEndpoints;
        monitoringResults.workingEndpoints = workingEndpoints;

        // Log progress every 50 endpoints
        if (testedEndpoints % 50 === 0) {
          console.log(`Tested ${testedEndpoints} endpoints, ${workingEndpoints} working...`);
        }
      } catch (error) {
        console.error(`Error testing ${url}:`, error.message);
      }
    }
  }

  console.log(`RPC monitoring completed. Tested ${testedEndpoints}/${totalEndpoints} endpoints, ${workingEndpoints} working.`);

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

    do {
      try {
        await testAllEndpoints();
      } catch (error) {
        console.error('Error during RPC monitoring:', error);
      }
      if (loop) console.log('RPC monitoring cycle complete. Restarting...');
    } while (loop);
  })();

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
