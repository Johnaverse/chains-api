import {
  getCachedData,
  searchChains,
  getChainById,
  getAllChains,
  getAllRelations,
  getRelationsById,
  getEndpointsById,
  getAllEndpoints,
  validateChainData,
} from './dataService.js';
import { getMonitoringResults, getMonitoringStatus } from './rpcMonitor.js';

/**
 * Get the list of MCP tool definitions (schemas)
 * @returns {Array} Array of tool definition objects
 */
export function getToolDefinitions() {
  return [
    {
      name: 'get_chains',
      description: 'Get all blockchain chains, optionally filtered by tag (Testnet, L2, or Beacon)',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'Optional tag to filter chains (e.g., "Testnet", "L2", "Beacon")',
            enum: ['Testnet', 'L2', 'Beacon'],
          },
        },
      },
    },
    {
      name: 'get_chain_by_id',
      description: 'Get detailed information about a specific blockchain chain by its chain ID',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to query (e.g., 1 for Ethereum mainnet, 137 for Polygon)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'search_chains',
      description: 'Search for blockchain chains by name or other attributes',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string (e.g., "ethereum", "polygon")',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_endpoints',
      description: 'Get RPC, firehose, and substreams endpoints for a specific chain or all chains',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Optional chain ID. If provided, returns endpoints for that chain only. If omitted, returns all endpoints.',
          },
        },
      },
    },
    {
      name: 'get_relations',
      description: 'Get chain relationships (testnet/mainnet, L2/L1, etc.) for a specific chain or all chains',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Optional chain ID. If provided, returns relations for that chain only. If omitted, returns all relations.',
          },
        },
      },
    },
    {
      name: 'get_slip44',
      description: 'Get SLIP-0044 coin type information by coin type ID or all coin types',
      inputSchema: {
        type: 'object',
        properties: {
          coinType: {
            type: 'number',
            description: 'Optional coin type ID (e.g., 0 for Bitcoin, 60 for Ethereum). If omitted, returns all coin types.',
          },
        },
      },
    },
    {
      name: 'get_sources',
      description: 'Get the status of all data sources (theGraph, chainlist, chains, slip44)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'validate_chains',
      description: 'Validate chain data for potential quality issues across 6 validation rules (relation conflicts, slip44 mismatches, name/testnet mismatches, sepolia/hoodie issues, status conflicts, goerli deprecation)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_rpc_monitor',
      description: 'Get RPC endpoint health check and monitoring results for all chains',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_rpc_monitor_by_id',
      description: 'Get RPC endpoint monitoring results for a specific chain by its chain ID',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to get RPC monitoring results for (e.g., 1 for Ethereum mainnet)',
          },
        },
        required: ['chainId'],
      },
    },
  ];
}

// --- Response helpers ---

function textResponse(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

function errorResponse(error, message) {
  const payload = message ? { error, message } : { error };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: true,
  };
}

function isValidChainId(chainId) {
  return typeof chainId === 'number' && !Number.isNaN(chainId);
}

// --- Individual tool handlers ---

function handleGetChains(args) {
  let chains = getAllChains();
  if (args.tag) {
    chains = chains.filter((chain) => chain.tags?.includes(args.tag));
  }
  return textResponse({ count: chains.length, chains });
}

function handleGetChainById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const chain = getChainById(chainId);
  if (!chain) {
    return errorResponse('Chain not found');
  }
  return textResponse(chain);
}

function handleSearchChains(args) {
  const { query } = args;
  if (!query) {
    return errorResponse('Query is required');
  }
  const results = searchChains(query);
  return textResponse({ query, count: results.length, results });
}

function handleGetEndpoints(args) {
  if (args.chainId === undefined) {
    const endpoints = getAllEndpoints();
    return textResponse({ count: endpoints.length, endpoints });
  }

  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const result = getEndpointsById(chainId);
  if (!result) {
    return errorResponse('Chain not found');
  }
  return textResponse(result);
}

function handleGetRelations(args) {
  if (args.chainId === undefined) {
    return textResponse(getAllRelations());
  }

  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const result = getRelationsById(chainId);
  if (!result) {
    return errorResponse('Chain not found');
  }
  return textResponse(result);
}

function handleGetSlip44(args) {
  const cachedData = getCachedData();
  if (!cachedData.slip44) {
    return errorResponse('SLIP-0044 data not loaded');
  }

  if (args.coinType === undefined) {
    return textResponse({
      count: Object.keys(cachedData.slip44).length,
      coinTypes: cachedData.slip44,
    });
  }

  const { coinType } = args;
  if (typeof coinType !== 'number' || Number.isNaN(coinType)) {
    return errorResponse('Invalid coin type');
  }
  const coinTypeData = cachedData.slip44[coinType];
  if (!coinTypeData) {
    return errorResponse('Coin type not found');
  }
  return textResponse(coinTypeData);
}

function handleGetSources() {
  const cachedData = getCachedData();
  return textResponse({
    lastUpdated: cachedData.lastUpdated,
    sources: {
      theGraph: cachedData.theGraph ? 'loaded' : 'not loaded',
      chainlist: cachedData.chainlist ? 'loaded' : 'not loaded',
      chains: cachedData.chains ? 'loaded' : 'not loaded',
      slip44: cachedData.slip44 ? 'loaded' : 'not loaded',
    },
  });
}

function handleValidateChains() {
  const validationResults = validateChainData();
  if (validationResults.error) {
    return errorResponse(validationResults.error);
  }
  return textResponse(validationResults);
}

function handleGetRpcMonitor() {
  const results = getMonitoringResults();
  const status = getMonitoringStatus();
  return textResponse({ ...status, ...results });
}

function handleGetRpcMonitorById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }

  const results = getMonitoringResults();
  const chainResults = results.results.filter((r) => r.chainId === chainId);

  if (chainResults.length === 0) {
    return errorResponse('No monitoring results found for this chain');
  }

  const workingCount = chainResults.filter((r) => r.status === 'working').length;
  return textResponse({
    chainId,
    chainName: chainResults[0].chainName,
    totalEndpoints: chainResults.length,
    workingEndpoints: workingCount,
    lastUpdated: results.lastUpdated,
    endpoints: chainResults,
  });
}

// --- Dispatch map ---

const toolHandlers = {
  get_chains: handleGetChains,
  get_chain_by_id: handleGetChainById,
  search_chains: handleSearchChains,
  get_endpoints: handleGetEndpoints,
  get_relations: handleGetRelations,
  get_slip44: handleGetSlip44,
  get_sources: handleGetSources,
  validate_chains: handleValidateChains,
  get_rpc_monitor: handleGetRpcMonitor,
  get_rpc_monitor_by_id: handleGetRpcMonitorById,
};

/**
 * Handle an MCP tool call by name and arguments
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} MCP response with content array
 */
export async function handleToolCall(name, args) {
  try {
    const handler = toolHandlers[name];
    if (!handler) {
      return errorResponse(`Unknown tool: ${name}`);
    }
    return handler(args);
  } catch (error) {
    return errorResponse('Internal error', error.message);
  }
}
