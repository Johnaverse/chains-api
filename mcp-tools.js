import {
  getCachedData,
  searchChains,
  getChainById,
  getAllChains,
  getAllRelations,
  getRelationsById,
  getEndpointsById,
  getAllEndpoints,
  getAllKeywords,
  validateChainData,
  traverseRelations,
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
      name: 'get_keywords',
      description: 'Get extracted keywords such as blockchain names, network names, software client names, tags, and relation kinds',
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
      description: 'Get RPC monitor status and summary endpoint health counts across all chains (without per-chain endpoint listing)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_stats',
      description: 'Get aggregate statistics: total chains, mainnets, testnets, L2s, beacons, and RPC health percentage',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'traverse_relations',
      description: 'BFS graph traversal of chain relations from a starting chain. Returns all reachable chains (nodes) and their relationship edges up to a given depth.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to start traversal from (e.g., 1 for Ethereum)',
          },
          depth: {
            type: 'number',
            description: 'Maximum traversal depth (1-5, default: 2)',
          },
        },
        required: ['chainId'],
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

function handleGetKeywords() {
  const cachedData = getCachedData();
  const keywordResults = getAllKeywords();

  return textResponse({
    lastUpdated: cachedData.lastUpdated,
    ...keywordResults,
  });
}

function handleValidateChains() {
  const validationResults = validateChainData();
  if (validationResults.error) {
    return errorResponse(validationResults.error);
  }
  return textResponse(validationResults);
}

function handleGetStats() {
  const chains = getAllChains();
  const monitorResults = getMonitoringResults();

  const totalChains = chains.length;
  const totalMainnets = chains.filter(c => !c.tags?.includes('Testnet') && !c.tags?.includes('L2') && !c.tags?.includes('Beacon')).length;
  const totalTestnets = chains.filter(c => c.tags?.includes('Testnet')).length;
  const totalL2s = chains.filter(c => c.tags?.includes('L2')).length;
  const totalBeacons = chains.filter(c => c.tags?.includes('Beacon')).length;

  const rpcTested = monitorResults.testedEndpoints;
  const rpcWorking = monitorResults.workingEndpoints;
  const rpcFailed = monitorResults.failedEndpoints || 0;
  const rpcHealthPercent = rpcTested > 0 ? Math.round((rpcWorking / rpcTested) * 10000) / 100 : null;

  return textResponse({
    totalChains,
    totalMainnets,
    totalTestnets,
    totalL2s,
    totalBeacons,
    rpc: {
      totalEndpoints: monitorResults.totalEndpoints,
      tested: rpcTested,
      working: rpcWorking,
      failed: rpcFailed,
      healthPercent: rpcHealthPercent,
    },
    lastUpdated: monitorResults.lastUpdated,
  });
}

function handleTraverseRelations(args) {
  const { chainId, depth } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }

  const maxDepth = depth !== undefined ? depth : 2;
  if (typeof maxDepth !== 'number' || maxDepth < 1 || maxDepth > 5) {
    return errorResponse('Invalid depth. Must be between 1 and 5');
  }

  const result = traverseRelations(chainId, maxDepth);
  if (!result) {
    return errorResponse('Chain not found');
  }
  return textResponse(result);
}

function getStatusLabel(status, results) {
  if (status.isMonitoring) return 'Running';
  if (results.testedEndpoints > 0) return 'Completed';
  return 'Starting up...';
}

function formatRpcMonitorStatus(status, results) {
  const lines = [
    '## RPC Monitoring Status',
    '',
    `**Status:** ${getStatusLabel(status, results)}`,
    `**Last Updated:** ${results.lastUpdated ?? 'N/A'}`,
    '',
    '### Summary',
    `- Total endpoints discovered: ${results.totalEndpoints}`,
    `- Endpoints tested: ${results.testedEndpoints}`,
    `- Working endpoints: ${results.workingEndpoints}`,
    `- Failed endpoints: ${results.failedEndpoints ?? 0}`,
    '- Use `get_rpc_monitor_by_id` for per-chain endpoint details.',
  ];

  if (!status.isMonitoring && results.testedEndpoints === 0) {
    lines.push(
      '',
      '> Monitoring has been started but has not completed a run yet. Check back shortly.',
      '> Use `get_rpc_monitor_by_id` with a chain ID once data is available.'
    );
  } else {
    lines.push('', '> Per-chain endpoint lists are available via `get_rpc_monitor_by_id`.');
  }

  return lines.join('\n');
}

function handleGetRpcMonitor() {
  const results = getMonitoringResults();
  const status = getMonitoringStatus();
  return { content: [{ type: 'text', text: formatRpcMonitorStatus(status, results) }] };
}

function handleGetRpcMonitorById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }

  const results = getMonitoringResults();
  const status = getMonitoringStatus();
  const chainResults = results.results.filter((r) => r.chainId === chainId);

  if (chainResults.length === 0) {
    const notRunYet = results.testedEndpoints === 0 && !status.isMonitoring;
    const message = notRunYet
      ? `No monitoring data available yet for chain ${chainId}. Monitoring has not completed a full run.`
      : `No working RPC endpoints found for chain ${chainId}.`;
    return { content: [{ type: 'text', text: message }] };
  }

  const workingCount = chainResults.filter((r) => r.status === 'working').length;
  const lines = [
    `## RPC Monitor — ${chainResults[0].chainName} (chain ${chainId})`,
    '',
    `**Last Updated:** ${results.lastUpdated ?? 'Never'}`,
    `**Working endpoints:** ${workingCount} / ${chainResults.length}`,
    '',
    '### Endpoints',
  ];
  for (const ep of chainResults) {
    const block = ep.blockNumber == null ? '' : ` — block #${ep.blockNumber}`;
    const latency = ep.latencyMs != null ? ` [${ep.latencyMs}ms]` : '';
    const client = ep.clientVersion && ep.clientVersion !== 'unavailable' ? ` (${ep.clientVersion})` : '';
    lines.push(
      `- **${ep.status}** ${ep.url}${block}${latency}${client}`,
      ...(ep.error ? [`  - Error: ${ep.error}`] : [])
    );
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
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
  get_keywords: handleGetKeywords,
  validate_chains: handleValidateChains,
  get_stats: handleGetStats,
  traverse_relations: handleTraverseRelations,
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
