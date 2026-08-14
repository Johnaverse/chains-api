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
  countChainsByTag,
  getRpcMonitoringResults,
  getRpcMonitoringStatus,
} from './dataService.js';
import { getL2BeatRefreshStatus } from './src/services/l2beatRefresher.js';
import { ensureChainRpcResults } from './src/services/chainRefresher.js';
import { getClientsByChain } from './clientsView.js';
import { getPricesForChains, getPriceForChain } from './priceService.js';
import {
  getAllStatusPages,
  getAllCoinStatusPages,
  getStatusPageByChainId,
  getStatusPageBySymbol,
} from './src/sources/statusPages.js';
import { getLiveIncidents } from './src/sources/liveIncidents.js';
import { getForumNews } from './src/sources/forumNews.js';
import { getWeb3News } from './src/sources/web3News.js';
import { getChainUpgrades } from './src/services/upgrades.js';
import { getProviderStats } from './src/services/providerStats.js';
import { checkChainHalt } from './src/services/chainHalt.js';

/**
 * Get the list of MCP tool definitions (schemas)
 * @returns {Array} Array of tool definition objects
 */
export function getToolDefinitions() {
  return [
    {
      name: 'get_chains',
      description:
        'List blockchain chains, optionally filtered by tag (Testnet/L2/Beacon) and/or lifecycle status. Returns a CAPPED sample (default 50, max 200) — `totalMatched` is the full number of chains matching the filter, `count` is how many are in this response, and `truncated` is true when there are more. When `truncated` is true, tell the user you are showing the first `count` of `totalMatched` (a display limit) and offer to narrow by tag/status or search by name — do NOT present the sample as the complete list. For an exact total or category breakdown use get_stats; to find a specific chain use search_chains. Never treat a tag/category count as the overall registry total. Each chain carries a `price` object for its NATIVE currency, or null when the asset is unmapped (only ~29 of ~3000 chains are): `{usd, vol24h, marketCap, asOf, stale}`. `vol24h` is the ASSET’s 24-hour trading volume in USD — market activity, NOT chain throughput or transaction count — so chains sharing an asset legitimately report the SAME volume (Optimism, Base and Arbitrum all report ETH’s), and you must name the asset when you quote it rather than implying it is that chain’s own activity. `asOf` is when CoinGecko last moved the number and `stale` is true when that is over a day old — some assets are still quoted months after their market ended. When `stale` is true, `vol24h` and `marketCap` are null (a closed window is not a weaker answer, it is a different one) and `usd` is the LAST KNOWN price: quote it as of `asOf`, never as current. A null field means unknown, never zero.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'Optional tag to filter chains (e.g., "Testnet", "L2", "Beacon")',
            enum: ['Testnet', 'L2', 'Beacon'],
          },
          status: {
            type: 'string',
            description: 'Optional lifecycle status filter (e.g. "deprecated" for retired chains, "active" for live ones)',
            enum: ['active', 'incubating', 'deprecated', 'unknown'],
          },
          limit: {
            type: 'number',
            description: 'Max chains to return (default 50, max 200)',
          },
        },
      },
    },
    {
      name: 'get_chain_by_id',
      description: 'Get detailed information about a specific blockchain chain by its chain ID. Includes a `price` object for the chain’s NATIVE currency (null when unmapped): `{usd, vol24h, marketCap, asOf, stale}`. `vol24h` is that ASSET’s 24-hour trading volume in USD — market activity, NOT chain throughput — so an L2 settling in ETH reports ETH’s volume, not its own; name the asset when quoting it. When `stale` is true the quote stopped moving at `asOf` (over a day ago): `vol24h` and `marketCap` are null and `usd` is the last known price, to be quoted as of `asOf` rather than as current. A null field is unknown, never zero.',
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
      description: 'Validate chain data for potential quality issues across 17 cross-source validation rules (relation conflicts, slip44/name/status mismatches, L2BEAT consistency, RPC drift, deprecated-parent propagation, and more)',
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
      description: 'Get aggregate statistics: total chains, mainnets, testnets, L2s, beacons, RPC health percentage, and a lifecycle breakdown — activeChains (non-deprecated), deprecatedChains, and byStatus (counts per active/incubating/deprecated). Use for "how many chains", "how many are active/deprecated".',
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
      description: 'Get RPC endpoint monitoring results for a specific chain by its chain ID. If the rolling monitor has not reached the chain yet (e.g. right after a deploy), its endpoints are checked live on demand, so a result is normally available.',
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
    {
      name: 'check_chain_halt',
      description:
        'Check whether a chain has STOPPED PRODUCING BLOCKS. Probes the chain\'s public RPC endpoints live for the latest block (height + block timestamp) and cross-checks a block explorer, then returns a verdict: "halted" (every responding source agrees on the same block and it is overdue), "delayed" (overdue but sources disagree), "endpoint_lagging" (chain is fine, a source is stuck on an old block — NOT a chain problem), "healthy", or "unknown" (fewer than two sources answered — this does NOT mean the chain is down). Use for "is X halted/stuck/stalled", "is X still producing blocks", "is X down". Distinct from get_rpc_monitor_by_id, which reports whether our probe could REACH an endpoint, and from get_live_incidents, which reports what the operator ANNOUNCED.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to check for a halt (e.g., 1 for Ethereum mainnet)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_scaling_chains',
      description: 'List chains classified by L2BEAT as scaling solutions (Optimistic Rollup, ZK Rollup, Validium, Optimium). Returns each chain\'s L2BEAT view (stage, category, stack, DA layer, host chain, TVS) plus a refresher freshness block indicating whether the data is live or from the static fallback snapshot.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_l2beat_by_id',
      description: 'Get L2BEAT scaling data for a single chain by chain ID. Includes stage classification, category, stack, DA layer, host chain, TVS, activity, and per-chain freshness metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to fetch L2BEAT data for (e.g., 42161 for Arbitrum One)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_refresher_status',
      description: 'Get the unified rolling chain refresher\'s current state: tick interval, in-flight status, queue depth, sweep cursor, plus per-job-type status for L2BEAT batches and RPC sweeps. Useful for diagnosing data freshness or stuck refreshes.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_clients',
      description: 'Get execution client software (name, version, GitHub repo, language) running on a chain, aggregated from live RPC endpoints. Omit chainId to get a summary across all chains.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Optional chain ID. If provided, returns clients for that chain only. If omitted, returns a summary across all chains with monitoring data.',
          },
        },
      },
    },
    {
      name: 'get_status_pages',
      description: 'Get the curated registry of operator status/incident pages. Returns chain-keyed projects (each with the chainIds it covers) plus coin/symbol-keyed entries for networks not represented by a chainId (e.g. Solana, Sui).',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_status_page_by_chain',
      description: 'Get the operator status/incident page covering a specific chain by its chain ID (e.g. 8453 for Base → base-l2.statuspage.io).',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'The chain ID to look up a status page for (e.g., 1 for Ethereum, 8453 for Base)',
          },
        },
        required: ['chainId'],
      },
    },
    {
      name: 'get_status_page_by_symbol',
      description: 'Get the operator status/incident page for a coin/network keyed by symbol rather than chain ID (e.g. SOL for Solana). Case-insensitive.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'The coin/network symbol to look up (e.g., "SOL", "SUI", "AAVE")',
          },
        },
        required: ['symbol'],
      },
    },
    {
      name: 'get_live_incidents',
      description:
        'Get LIVE incidents and scheduled maintenance from chain operator status pages and RPC provider status pages (Infura, QuickNode, dRPC, Pinax). Use for questions like "is X down", "any incidents today", "provider outages". Each item carries a lifecycle `status` and an `ongoing` flag: for "is X down right now" pass ongoing=true; for "scheduled/upcoming maintenance" pass status="maintenance_scheduled" (its publishedAt is when the maintenance starts). `chainLevel` is the important one for "is CHAIN X healthy": each entry is a chain that TWO OR MORE independent RPC providers are reporting at the same time, which is evidence about the chain rather than about one provider — lead with it and say how many providers agree. It is computed across all ongoing provider incidents, so it is present even when a chainId filter narrowed `incidents`. A provider incident usually does not declare a chain, so `chainId` also matches a chain read from the incident title; `chainEvidence` says which ("declared" or "title"), and an incident naming a non-EVM network with no chainId in the registry is never attributed at all. Near-real-time (cached ~60s).',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['chain', 'provider', 'all'],
            description: 'chain = network operator incidents, provider = RPC provider incidents, all = both (default)',
          },
          chainId: {
            type: 'number',
            description: 'Only incidents affecting this chain ID',
          },
          provider: {
            type: 'string',
            description: 'Only incidents from this RPC provider id (e.g. "infura", "quicknode")',
          },
          ongoing: {
            type: 'boolean',
            description: 'true = only currently-active incidents/outages (best for "is X down right now"); false = only non-active items (resolved, completed, or not-yet-started maintenance)',
          },
          status: {
            type: 'string',
            enum: [
              'investigating', 'identified', 'monitoring', 'resolved',
              'maintenance_scheduled', 'maintenance_in_progress', 'maintenance_completed',
              'operational', 'degraded', 'partial_outage', 'major_outage', 'unknown',
            ],
            description: 'Only incidents in this exact lifecycle state. Use "maintenance_scheduled" for upcoming/planned maintenance, or "investigating"/"identified"/"monitoring" for open incidents',
          },
          limit: {
            type: 'number',
            description: 'Max incidents to return (default 30, max 100)',
          },
        },
      },
    },
    {
      name: 'get_forum_news',
      description:
        'Get recent posts from official chain community/governance forums (Ethereum Magicians, Arbitrum DAO, …), keyed by chain ID. Use for questions about governance discussions, proposals, upgrades being debated, or community news. Near-real-time (cached ~60s).',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Only posts tied to this chain ID',
          },
          forum: {
            type: 'string',
            description: 'Only posts from this forum id (e.g. "ethereum", "arbitrum")',
          },
          limit: {
            type: 'number',
            description: 'Max posts to return (default 15, max 50)',
          },
        },
      },
    },
    {
      name: 'get_chain_upgrades',
      description:
        'Get the cross-feed upgrade timeline: scheduled/completed network upgrades and maintenance windows with the REQUIRED SOFTWARE ({client, version} operators must run), urgency (standard/urgent/mandatory), activation time WITH ITS EVIDENCE, incidents that followed on the same network within 24h (labelled suspectedCause: "upgrade" — temporal correlation, not asserted causation), and related forum discussion + news coverage. Use for "when is the next upgrade for X", "what version is required", "did the upgrade cause incidents", "hard fork schedule". `network` accepts a name for chains with no EVM chain ID (e.g. "Solana", "Canton"). NEVER read `activationAt` without `activationEvidence`: `window`/`scheduled` mean a stated time you may count down to; `started`/`completed` are OBSERVED and approximate (`completed` is an upper bound on the run, not its start, so say "completed by"); `announced` means the provider announced the upgrade and never named a day — `activationAt` is null and you must say the date is not announced yet rather than implying one. Evidence strength wins over recency, so a later exact window overrides an earlier undated announcement. `windowMinutes`/`windowEndAt` exist only for `window` evidence. On followedByIncidents, `durationEvidence` is `observed` (resolvedAt is real), `ongoing` (still open), or `unpublished` (the page never said when it ended — do not state a duration). Returns a capped list with totalMatched/truncated — say when you are showing a subset.',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Only upgrades touching this chain ID',
          },
          network: {
            type: 'string',
            description: 'Network name or slug (e.g. "Solana Mainnet", "gnosis") — use for networks that have no EVM chain ID',
          },
          limit: {
            type: 'number',
            description: 'Max upgrades to return (default 20, max 50)',
          },
        },
      },
    },
    {
      name: 'get_provider_stats',
      description:
        'Get per-RPC-provider quality indicators (Infura, QuickNode, Alchemy, dRPC, Chainstack, …): incidents30d, ongoingNow (open INCIDENTS only), ongoingMaintenance (planned windows in progress — never call these outages), maintenance30d, chainsAffected30d, oldestOngoingAt (start of the longest-running open incident), resolutionHours (median/avg time-to-resolve, usually null), availability, endpointReachability, and chain coverage. For "which provider is most reliable/available" use `availability`: CHAIN-WEIGHTED over three windows (last24h/last7d/last30d), each {percent, chainHoursLost} where percent = 1 − chain-hours lost / (chainsSupported × window hours) — so 1 of 10 supported chains down for a full 24h window is 90%, not 0%. chainsSupported is ONLY what the provider lists on its own status page; when that coverage is unavailable the percents are null with a note. It is SELF-REPORTED: a provider that never posts incidents scores a perfect 100 (a silent status page looks perfect), so always say it is self-reported. Most status pages publish an incident only ONCE, at resolution, so its duration is unknown and it is EXCLUDED from the percent rather than charged as downtime — compare availability.measuredIncidents against unknownDurationIncidents before ranking providers on it, and when measuredIncidents is 0 say the percent means "nothing open right now", not "a clean month". Use disclosure.comparable to decide whether a provider belongs in a ranking at all; a "partial window" note means feed retention is younger than the window. `endpointReachability` ({working, total, percent, registryChains}) measures whether REGISTRY-LISTED endpoint URLs answer chains-api\'s probes — keyed/stale/geo-blocked registry URLs fail by design, so it is a registry data-quality signal; do NOT present it as provider uptime.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Only this provider id (e.g. "infura", "quicknode", "alchemy"). Omit for all providers, sorted by incidents30d descending',
          },
        },
      },
    },
    {
      name: 'get_web3_news',
      description:
        'Get recent blockchain/web3 ecosystem news from curated publishers (Ethereum Foundation blog, Vitalik\'s blog, Consensys, CoinDesk, Decrypt, The Block). Use for "what is new with X", upgrade/hard-fork announcements, research, funding and ecosystem developments. Distinct from the other feeds: get_live_incidents is outages/maintenance and get_forum_news is governance discussion — this is what the ecosystem publishes about itself. `weight` separates protocol/research sources ("primary") from news desks that also cover markets ("secondary"); prefer primary for protocol facts. Returns a capped list (default 15, max 50) with `totalMatched`; when it exceeds `count`, say you are showing the most recent subset. Near-real-time (cached ~60s).',
      inputSchema: {
        type: 'object',
        properties: {
          chainId: {
            type: 'number',
            description: 'Only news mapped to this chain ID. Mapping is precision-first, so many articles carry no chain — omit this for broad questions',
          },
          sourceId: {
            type: 'string',
            description: 'Only news from this source id (e.g. "ethereum-foundation", "coindesk", "vitalik")',
          },
          weight: {
            type: 'string',
            enum: ['primary', 'secondary'],
            description: 'primary = protocol/research publishing (EF, Vitalik, Consensys), secondary = news desks including market coverage',
          },
          limit: {
            type: 'number',
            description: 'Max articles to return (default 15, max 50)',
          },
        },
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

const GET_CHAINS_DEFAULT_LIMIT = 50;
const GET_CHAINS_MAX_LIMIT = 200;

async function handleGetChains(args) {
  let chains = getAllChains();
  if (args.tag) {
    chains = chains.filter((chain) => chain.tags?.includes(args.tag));
  }
  if (args.status) {
    chains = chains.filter((chain) => (chain.status || 'unknown') === args.status);
  }
  // The registry has ~3000 chains; returning them all (with a price lookup
  // each) is a huge payload that overflows an LLM's context and makes it lose
  // the true total. Cap the list, report totalMatched so callers still get the
  // honest count, and only price-enrich the slice actually returned.
  const totalMatched = chains.length;
  const limit = Math.max(1, Math.min(Number(args.limit) || GET_CHAINS_DEFAULT_LIMIT, GET_CHAINS_MAX_LIMIT));
  const sliced = chains.slice(0, limit);
  const priceMap = await getPricesForChains(sliced.map((c) => c.chainId));
  const enrichedChains = sliced.map((chain) => ({
    ...chain,
    price: priceMap.get(chain.chainId) ?? null,
  }));
  return textResponse({
    totalMatched,
    count: enrichedChains.length,
    truncated: totalMatched > enrichedChains.length,
    chains: enrichedChains,
  });
}

async function handleGetChainById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const chain = getChainById(chainId);
  if (!chain) {
    return errorResponse('Chain not found');
  }
  const price = await getPriceForChain(chainId);
  return textResponse({ ...chain, price });
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
  const monitorResults = getRpcMonitoringResults();

  const { totalChains, totalMainnets, totalTestnets, totalL2s, totalBeacons, byStatus, activeChains, deprecatedChains } = countChainsByTag(chains);

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
    activeChains,
    deprecatedChains,
    byStatus,
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

  const maxDepth = depth ?? 2;
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
  const results = getRpcMonitoringResults();
  const status = getRpcMonitoringStatus();
  return { content: [{ type: 'text', text: formatRpcMonitorStatus(status, results) }] };
}

async function handleGetRpcMonitorById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }

  let results = getRpcMonitoringResults();
  let chainResults = results.results.filter((r) => r.chainId === chainId);

  // Post-deploy blind window: the rolling sweep may not have reached this
  // chain yet. Probe its endpoints on demand instead of answering "nothing".
  if (chainResults.length === 0 && (await ensureChainRpcResults(chainId))) {
    results = getRpcMonitoringResults();
    chainResults = results.results.filter((r) => r.chainId === chainId);
  }

  if (chainResults.length === 0) {
    // Still nothing even after the on-demand attempt: the chain is unknown or
    // has no publicly checkable endpoints — it must never read as "the
    // endpoints are down". An earlier message here ("No working RPC endpoints
    // found") made the assistant declare healthy chains unhealthy.
    const registered = getEndpointsById(chainId);
    const rpcCount = registered?.rpc?.length ?? null;
    const message =
      `RPC health status for chain ${chainId} is UNKNOWN: the monitor has no results for this chain` +
      ` and a live on-demand check found no publicly checkable endpoints. This does NOT mean the endpoints are down.` +
      (rpcCount ? ` The registry lists ${rpcCount} RPC endpoint(s) for this chain (see get_endpoints).` : '') +
      ` Do not report this chain as unhealthy based on this result.`;
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
    const latency = ep.latencyMs == null ? '' : ` [${ep.latencyMs}ms]`;
    const client = ep.clientVersion && ep.clientVersion !== 'unavailable' ? ` (${ep.clientVersion})` : '';
    lines.push(
      `- **${ep.status}** ${ep.url}${block}${latency}${client}`,
      ...(ep.error ? [`  - Error: ${ep.error}`] : [])
    );
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function handleCheckChainHalt(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const result = await checkChainHalt(chainId);
  return textResponse(result);
}

function handleGetClients(args) {
  if (args.chainId === undefined) {
    const results = getRpcMonitoringResults();
    const chains = getClientsByChain();
    return textResponse({
      lastUpdated: results.lastUpdated,
      count: chains.length,
      chains,
    });
  }

  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const summary = getClientsByChain(chainId);
  if (!summary) {
    return errorResponse('No client data found for this chain');
  }
  return textResponse(summary);
}

// --- Dispatch map ---

function handleGetScalingChains() {
  const chains = getAllChains().filter((c) => c.l2Beat);
  return textResponse({
    count: chains.length,
    refresher: getL2BeatRefreshStatus(),
    chains,
  });
}

function handleGetL2BeatById(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chainId', 'chainId must be a positive integer');
  }
  const chain = getChainById(chainId);
  if (!chain) {
    return errorResponse('Not found', `No chain with chainId ${chainId}`);
  }
  if (!chain.l2Beat) {
    return errorResponse('Not found', `Chain ${chainId} (${chain.name}) is not classified by L2BEAT`);
  }
  return textResponse(chain);
}

function handleGetRefresherStatus() {
  return textResponse(getL2BeatRefreshStatus());
}

function handleGetStatusPages() {
  const chains = getAllStatusPages();
  const coins = getAllCoinStatusPages();
  return textResponse({
    chainCount: chains.length,
    coinCount: coins.length,
    statusPages: chains,
    coins,
  });
}

function handleGetStatusPageByChain(args) {
  const { chainId } = args;
  if (!isValidChainId(chainId)) {
    return errorResponse('Invalid chain ID');
  }
  const page = getStatusPageByChainId(chainId);
  if (!page) {
    return errorResponse('No status page found for this chain');
  }
  return textResponse(page);
}

function handleGetStatusPageBySymbol(args) {
  const { symbol } = args;
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    return errorResponse('Symbol is required');
  }
  const page = getStatusPageBySymbol(symbol);
  if (!page) {
    return errorResponse('No status page found for this symbol');
  }
  return textResponse(page);
}

async function handleGetForumNews(args) {
  const { chainId, forum, limit } = args ?? {};
  try {
    const result = await getForumNews({ chainId, forum, limit });
    // publishedMs/freshMs are internal sort/recency keys; drop from tool output
    return textResponse({
      ...result,
      news: result.news.map(({ publishedMs: _publishedMs, freshMs: _freshMs, ...rest }) => rest),
    });
  } catch (error) {
    return errorResponse('Forum news feed unavailable', error.message);
  }
}

async function handleGetChainUpgrades(args) {
  const { chainId, network, limit } = args ?? {};
  try {
    const result = await getChainUpgrades({ chainId, network, limit });
    return textResponse(result);
  } catch (error) {
    return errorResponse('Upgrade timeline unavailable', error.message);
  }
}

async function handleGetProviderStats(args) {
  const { provider } = args ?? {};
  try {
    const result = await getProviderStats({ provider });
    return textResponse(result);
  } catch (error) {
    return errorResponse('Provider stats unavailable', error.message);
  }
}

async function handleGetWeb3News(args) {
  const { chainId, sourceId, weight, limit } = args ?? {};
  try {
    const result = await getWeb3News({ chainId, sourceId, weight, limit });
    // publishedMs is an internal sort key; drop it from tool output.
    return textResponse({
      ...result,
      news: result.news.map(({ publishedMs: _publishedMs, ...rest }) => rest),
    });
  } catch (error) {
    return errorResponse('Web3 news feed unavailable', error.message);
  }
}

async function handleGetLiveIncidents(args) {
  const { type, chainId, provider, ongoing, status, limit } = args ?? {};
  try {
    const result = await getLiveIncidents({ type, chainId, provider, ongoing, status, limit });
    // publishedMs is an internal sort key; drop it from tool output
    return textResponse({
      ...result,
      incidents: result.incidents.map(({ publishedMs: _publishedMs, ...rest }) => rest),
    });
  } catch (error) {
    return errorResponse('Live incident feed unavailable', error.message);
  }
}

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
  check_chain_halt: handleCheckChainHalt,
  get_scaling_chains: handleGetScalingChains,
  get_l2beat_by_id: handleGetL2BeatById,
  get_refresher_status: handleGetRefresherStatus,
  get_clients: handleGetClients,
  get_status_pages: handleGetStatusPages,
  get_status_page_by_chain: handleGetStatusPageByChain,
  get_status_page_by_symbol: handleGetStatusPageBySymbol,
  get_live_incidents: handleGetLiveIncidents,
  get_forum_news: handleGetForumNews,
  get_web3_news: handleGetWeb3News,
  get_chain_upgrades: handleGetChainUpgrades,
  get_provider_stats: handleGetProviderStats,
};

/**
 * Handle an MCP tool call by name and arguments
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<Object>} MCP response with content array
 */
export async function handleToolCall(name, args) {
  try {
    // Own-property lookup only: a bare toolHandlers[name] reaches the
    // prototype chain, so a caller asking for "constructor" got Object
    // invoked as the handler (returning its args as the response) instead
    // of an unknown-tool error.
    const handler = Object.hasOwn(toolHandlers, name) ? toolHandlers[name] : null;
    if (!handler) {
      return errorResponse(`Unknown tool: ${name}`);
    }
    return await handler(args);
  } catch (error) {
    return errorResponse('Internal error', error.message);
  }
}

