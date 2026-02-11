import fetch from 'node-fetch';
import { getAllEndpoints } from './dataService.js';

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
 * Make JSON-RPC call to endpoint
 */
async function makeRpcCall(url, method, params = []) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: method,
        params: params,
        id: 1
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
    }
    
    return data.result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
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
      const clientVersion = await makeRpcCall(url, 'web3_clientVersion');
      result.clientVersion = clientVersion;
    } catch (error) {
      // Some RPC endpoints might not support web3_clientVersion, continue anyway
      result.clientVersion = 'unavailable';
    }
    
    // Get latest block number
    const blockNumberHex = await makeRpcCall(url, 'eth_blockNumber');
    
    // Convert hex to decimal
    const blockNumber = parseInt(blockNumberHex, 16);
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
  const results = [];
  let totalEndpoints = 0;
  let testedEndpoints = 0;
  let workingEndpoints = 0;
  
  const MAX_ENDPOINTS_PER_CHAIN = 5; // Limit testing to first 5 valid endpoints per chain
  
  for (const chainEndpoints of allEndpoints) {
    const { chainId, name, rpc } = chainEndpoints;
    
    if (!rpc || rpc.length === 0) {
      continue;
    }
    
    let chainTestedCount = 0;
    
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
      
      testedEndpoints++;
      chainTestedCount++;
      
      try {
        const testResult = await testRpcEndpoint(url);
        
        if (testResult.status === 'working') {
          workingEndpoints++;
        }
        
        results.push({
          chainId,
          chainName: name,
          ...testResult
        });
        
        // Log progress every 50 endpoints
        if (testedEndpoints % 50 === 0) {
          console.log(`Tested ${testedEndpoints} endpoints, ${workingEndpoints} working...`);
        }
      } catch (error) {
        console.error(`Error testing ${url}:`, error.message);
      }
    }
  }
  
  // Update monitoring results
  monitoringResults = {
    lastUpdated: new Date().toISOString(),
    totalEndpoints,
    testedEndpoints,
    workingEndpoints,
    results
  };
  
  console.log(`RPC monitoring completed. Tested ${testedEndpoints}/${totalEndpoints} endpoints, ${workingEndpoints} working.`);
  
  return monitoringResults;
}

/**
 * Start background monitoring (runs once at startup)
 */
export async function startMonitoring() {
  if (isMonitoring) {
    console.log('Monitoring already in progress, skipping...');
    return;
  }
  
  isMonitoring = true;
  
  try {
    await testAllEndpoints();
  } catch (error) {
    console.error('Error during RPC monitoring:', error);
  } finally {
    isMonitoring = false;
  }
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
