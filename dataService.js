import {
  DATA_SOURCE_THE_GRAPH, DATA_SOURCE_CHAINLIST,
  DATA_SOURCE_CHAINS, DATA_SOURCE_SLIP44,
  RPC_CHECK_TIMEOUT_MS, RPC_CHECK_CONCURRENCY
} from './config.js';
import { proxyFetch } from './fetchUtil.js';
import { jsonRpcCall } from './rpcUtil.js';

// Data source URLs (from config, overridable via env)
const DATA_SOURCES = {
  theGraph: DATA_SOURCE_THE_GRAPH,
  chainlist: DATA_SOURCE_CHAINLIST,
  chains: DATA_SOURCE_CHAINS,
  slip44: DATA_SOURCE_SLIP44
};

// Cache for data
let cachedData = {
  theGraph: null,
  chainlist: null,
  chains: null,
  slip44: null,
  indexed: null,
  lastUpdated: null,
  rpcHealth: {},
  lastRpcCheck: null
};

let rpcCheckInProgress = false;
let rpcCheckPending = false;

/**
 * Fetch data from a URL with error handling
 */
export async function fetchData(url, format = 'json') {
  try {
    const response = await proxyFetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    if (format === 'json') {
      return await response.json();
    } else if (format === 'text') {
      return await response.text();
    }
  } catch (error) {
    console.error(`Error fetching data from ${url}:`, error.message);
    return null;
  }
}

/**
 * Parse SLIP-0044 markdown file to extract coin types
 * Table structure: | Coin type | Path component | Symbol | Coin |
 * Uses "Coin type" as the key (id)
 */
export function parseSLIP44(markdown) {
  if (!markdown) return {};

  const slip44Data = {};
  const lines = markdown.split('\n');
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !line.includes('|')) {
      continue;
    }

    // Detect table rows (format: | Coin type | Path component | Symbol | Coin |)
    const cells = line.split('|').map(cell => cell.trim()).filter(Boolean);

    // Skip header and separator rows
    if (cells[0] === 'Coin type' || cells[0].includes('-')) {
      inTable = true;
      continue;
    }

    if (!inTable || cells.length < 4) {
      continue;
    }

    const coinTypeNum = Number.parseInt(cells[0], 10);
    if (Number.isNaN(coinTypeNum)) {
      continue;
    }

    slip44Data[coinTypeNum] = {
      coinType: coinTypeNum,
      pathComponent: cells[1],
      symbol: cells[2],
      coin: cells[3]
    };
  }

  return slip44Data;
}

/**
 * Build a mapping of network IDs to chain IDs from The Graph data
 */
function buildNetworkIdToChainIdMap(theGraph) {
  const networkIdToChainId = {};
  
  if (Array.isArray(theGraph?.networks)) {
    theGraph.networks.forEach(network => {
      // Extract chain ID from caip2Id (format: "eip155:1" or "beacon:11155111")
      // Note: Only numeric chain IDs are supported; named beacon chains (e.g., "beacon:mainnet")
      // won't be mapped but will still add tags to their target chains if relations exist
      if (network.caip2Id) {
        const match = network.caip2Id.match(/^(?:eip155|beacon):(\d+)$/);
        if (match) {
          const chainId = Number.parseInt(match[1], 10);
          networkIdToChainId[network.id] = chainId;
        }
      }
    });
  }
  
  return networkIdToChainId;
}

/**
 * Helper function to add Beacon tag to a target chain
 */
function addBeaconTagToTargetChain(indexed, targetChainId) {
  if (targetChainId !== undefined && indexed.byChainId[targetChainId]) {
    if (!indexed.byChainId[targetChainId].tags) {
      indexed.byChainId[targetChainId].tags = [];
    }
    if (!indexed.byChainId[targetChainId].tags.includes('Beacon')) {
      indexed.byChainId[targetChainId].tags.push('Beacon');
    }
  }
}

/**
 * Helper function to get bridge URL from a bridge object or string
 */
function getBridgeUrl(bridge) {
  if (typeof bridge === 'string') {
    return bridge;
  }
  return bridge?.url ?? null;
}

/**
 * Helper function to merge bridge URLs into a chain's bridges array
 */
function mergeBridges(chain, newBridges) {
  if (!newBridges || !Array.isArray(newBridges)) {
    return;
  }

  if (!chain.bridges) {
    chain.bridges = [];
  }

  // Build a set of existing bridge URLs for comparison
  const existingBridgeUrls = new Set(
    chain.bridges.map(getBridgeUrl).filter(url => url !== null)
  );

  newBridges.forEach(bridge => {
    const url = getBridgeUrl(bridge);
    if (url && !existingBridgeUrls.has(url)) {
      chain.bridges.push(bridge);
      existingBridgeUrls.add(url);
    }
  });
}

/**
 * Process L2 parent relation from chains.json
 */
function processL2ParentRelation(chain, indexed) {
  if (chain.parent?.type !== 'L2' || !chain.parent?.chain) {
    return;
  }

  const match = chain.parent.chain.match(/^eip155-(\d+)$/);
  if (!match) return;

  const chainId = chain.chainId;
  const parentChainId = Number.parseInt(match[1], 10);

  if (!indexed.byChainId[chainId]) return;

  // Add L2 tag
  if (!indexed.byChainId[chainId].tags.includes('L2')) {
    indexed.byChainId[chainId].tags.push('L2');
  }

  // Add l2Of relation if it doesn't exist
  const existingRelation = indexed.byChainId[chainId].relations.find(
    r => r.kind === 'l2Of' && r.chainId === parentChainId
  );

  if (!existingRelation) {
    indexed.byChainId[chainId].relations.push({
      kind: 'l2Of',
      network: chain.parent.chain,
      chainId: parentChainId,
      source: 'chains'
    });
  }

  // Extract bridge URLs
  mergeBridges(indexed.byChainId[chainId], chain.parent.bridges);
}

/**
 * Merge RPC URLs from a source array into an existing chain's rpc array,
 * deduplicating by URL string.
 * @param {Object} existingChain - The chain object to merge into
 * @param {Array} newRpcUrls - Array of RPC entries (string or {url: string})
 */
function mergeRpcUrlsFromArray(existingChain, newRpcUrls) {
  if (!newRpcUrls || !Array.isArray(newRpcUrls)) {
    return;
  }

  if (!existingChain.rpc) {
    existingChain.rpc = [];
  }

  const existingRpcUrls = new Set();
  existingChain.rpc.forEach(rpc => {
    const url = typeof rpc === 'string' ? rpc : rpc.url;
    if (url) existingRpcUrls.add(url);
  });

  newRpcUrls.forEach(rpc => {
    const url = typeof rpc === 'string' ? rpc : rpc.url;
    if (url && !existingRpcUrls.has(url)) {
      existingChain.rpc.push(rpc);
      existingRpcUrls.add(url);
    }
  });
}

/**
 * Merge single chainlist entry into indexed data
 */
function mergeChainlistEntry(chainData, indexed) {
  const chainId = chainData.chainId;

  if (indexed.byChainId[chainId]) {
    mergeRpcUrlsFromArray(indexed.byChainId[chainId], chainData.rpc);

    if (!indexed.byChainId[chainId].sources.includes('chainlist')) {
      indexed.byChainId[chainId].sources.push('chainlist');
    }

    if (chainData.status && !indexed.byChainId[chainId].status) {
      indexed.byChainId[chainId].status = chainData.status;
    }
  } else {
    indexed.byChainId[chainId] = {
      chainId: Number(chainId),
      name: chainData.name,
      rpc: chainData.rpc || [],
      sources: ['chainlist'],
      tags: [],
      relations: [],
      status: chainData.status || 'active'
    };
  }

  // Mark as testnet if applicable
  if ((chainData.slip44 === 1 || chainData.isTestnet === true)) {
    if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
      indexed.byChainId[chainId].tags.push('Testnet');
    }
  }
}

/**
 * Extract chain ID from caip2Id format (e.g., "eip155:1")
 */
function extractChainIdFromCaip2Id(caip2Id) {
  if (!caip2Id) return null;
  const match = caip2Id.match(/^eip155:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Create new chain entry from The Graph network data
 */
function createTheGraphChainEntry(chainId, network) {
  return {
    chainId,
    name: network.fullName || network.shortName || network.id || 'Unknown',
    shortName: network.shortName,
    nativeCurrency: { symbol: network.nativeToken },
    rpc: network.rpcUrls || [],
    explorers: network.explorerUrls || [],
    sources: ['theGraph'],
    tags: [],
    relations: [],
    status: 'active'
  };
}


/**
 * Process a single The Graph relation
 */
function processTheGraphRelation(relation, chainId, indexed, networkIdToChainId) {
  const { kind, network: targetNetworkId } = relation;
  const targetChainId = networkIdToChainId[targetNetworkId];

  const relationData = {
    kind,
    network: targetNetworkId,
    ...(targetChainId !== undefined && { chainId: targetChainId }),
    source: 'theGraph'
  };

  indexed.byChainId[chainId].relations.push(relationData);

  // Add tags based on relation kind
  if (kind === 'testnetOf' && !indexed.byChainId[chainId].tags.includes('Testnet')) {
    indexed.byChainId[chainId].tags.push('Testnet');
  } else if (kind === 'l2Of' && !indexed.byChainId[chainId].tags.includes('L2')) {
    indexed.byChainId[chainId].tags.push('L2');
  } else if (kind === 'beaconOf') {
    addBeaconTagToTargetChain(indexed, targetChainId);
  }
}

/**
 * Create or merge The Graph chain entry
 */
function createOrMergeTheGraphChain(chainId, network, indexed) {
  if (indexed.byChainId[chainId]) {
    if (!indexed.byChainId[chainId].sources.includes('theGraph')) {
      indexed.byChainId[chainId].sources.push('theGraph');
    }
    mergeRpcUrlsFromArray(indexed.byChainId[chainId], network.rpcUrls);

    // Ensure arrays exist
    if (!indexed.byChainId[chainId].tags) indexed.byChainId[chainId].tags = [];
    if (!indexed.byChainId[chainId].relations) indexed.byChainId[chainId].relations = [];
  } else {
    indexed.byChainId[chainId] = createTheGraphChainEntry(chainId, network);
  }
}

/**
 * Add testnet tag if network is marked as testnet
 */
function addTestnetTagIfApplicable(chainId, network, indexed) {
  if (network.networkType === 'testnet') {
    if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
      indexed.byChainId[chainId].tags.push('Testnet');
    }
  }
}

/**
 * Process all relations for a The Graph network
 */
function processTheGraphNetworkRelations(network, chainId, indexed, networkIdToChainId) {
  if (network.relations && Array.isArray(network.relations)) {
    network.relations.forEach(relation => {
      processTheGraphRelation(relation, chainId, indexed, networkIdToChainId);
    });
  }
}

/**
 * Add The Graph specific data to chain
 */
function addTheGraphSpecificData(chainId, network, indexed) {
  indexed.byChainId[chainId].theGraph = {
    id: network.id,
    fullName: network.fullName,
    shortName: network.shortName,
    caip2Id: network.caip2Id,
    aliases: network.aliases,
    networkType: network.networkType,
    services: network.services,
    nativeToken: network.nativeToken
  };
}

/**
 * Add chain to name index
 */
function addChainToNameIndex(chainId, network, indexed) {
  const nameLower = (network.fullName || network.shortName || '').toLowerCase();
  if (nameLower && !indexed.byName[nameLower]) {
    indexed.byName[nameLower] = [];
  }
  if (nameLower && !indexed.byName[nameLower].includes(chainId)) {
    indexed.byName[nameLower].push(chainId);
  }
}

/**
 * Process beacon chain relations
 */
function processBeaconChainRelations(network, networkIdToChainId, indexed) {
  if (network.relations && Array.isArray(network.relations)) {
    network.relations.forEach(relation => {
      if (relation.kind === 'beaconOf') {
        const targetChainId = networkIdToChainId[relation.network];
        addBeaconTagToTargetChain(indexed, targetChainId);
      }
    });
  }
}

/**
 * Process The Graph network entry
 */
function processTheGraphNetwork(network, indexed, networkIdToChainId) {
  const chainId = extractChainIdFromCaip2Id(network.caip2Id);
  const isBeaconChain = network.caip2Id?.startsWith('beacon:');

  if (chainId !== null) {
    createOrMergeTheGraphChain(chainId, network, indexed);
    addTestnetTagIfApplicable(chainId, network, indexed);
    processTheGraphNetworkRelations(network, chainId, indexed, networkIdToChainId);
    addTheGraphSpecificData(chainId, network, indexed);
    addChainToNameIndex(chainId, network, indexed);
  } else if (isBeaconChain) {
    processBeaconChainRelations(network, networkIdToChainId, indexed);
  }
}

/**
 * Index all data into a searchable structure
 */
export function indexData(theGraph, chainlist, chains, slip44) {
  const indexed = {
    byChainId: {},
    byName: {},
    all: []
  };
  
  // Build network ID to chain ID mapping for resolving relations
  const networkIdToChainId = buildNetworkIdToChainIdMap(theGraph);
  
  // Index chains data
  if (Array.isArray(chains)) {
    chains.forEach(chain => {
      const chainId = chain.chainId;
      if (chainId !== undefined) {
        if (!indexed.byChainId[chainId]) {
          indexed.byChainId[chainId] = {
            chainId,
            name: chain.name,
            shortName: chain.shortName,
            network: chain.network,
            nativeCurrency: chain.nativeCurrency,
            rpc: chain.rpc || [],
            explorers: chain.explorers || [],
            infoURL: chain.infoURL,
            sources: ['chains'],
            tags: [],
            relations: [],
            status: chain.status || 'active' // Default to 'active' if not present
          };
        }
        
        // Check slip44 for testnet marking
        if (chain.slip44 === 1) {
          if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
            indexed.byChainId[chainId].tags.push('Testnet');
          }
        }
        
        const nameLower = (chain.name || '').toLowerCase();
        if (!indexed.byName[nameLower]) {
          indexed.byName[nameLower] = [];
        }
        indexed.byName[nameLower].push(chainId);
      }
    });
    
    // Process L2 relations and bridge URLs from parent field in chains.json
    chains.forEach(chain => {
      if (chain.chainId !== undefined) {
        processL2ParentRelation(chain, indexed);
      }
    });
  }
  
  // Merge chainlist RPC data
  // chainlist is an array of chain objects, each with chainId, name, rpc, etc.
  if (chainlist && Array.isArray(chainlist)) {
    chainlist.forEach(chainData => {
      const chainId = chainData.chainId;

      // Skip if chainId is not valid
      if (chainId === undefined || chainId === null || Number.isNaN(Number(chainId))) {
        return;
      }

      mergeChainlistEntry(chainData, indexed);
    });
    
    // Second pass: Find mainnet relations for testnets from chainlist
    // Use tvl value and isTestnet flag
    chainlist.forEach(testnetData => {
      const testnetChainId = testnetData.chainId;
      
      // Skip if chainId is not valid (reusing same validation logic)
      if (testnetChainId === undefined || testnetChainId === null || Number.isNaN(Number(testnetChainId))) {
        return;
      }
      
      // Check if it's a testnet
      if ((testnetData.slip44 === 1 || testnetData.isTestnet === true) && testnetData.tvl !== undefined) {
        // Find mainnet with same tvl but isTestnet: false
        const mainnetData = chainlist.find(chain => {
          return chain.tvl === testnetData.tvl &&
                 chain.isTestnet === false &&
                 chain.chainId !== testnetChainId;
        });
        
        if (mainnetData && indexed.byChainId[testnetChainId]) {
          const mainnetChainId = mainnetData.chainId;
          
          // Add testnetOf relation
          const relation = {
            kind: 'testnetOf',
            network: mainnetData.name,
            chainId: Number(mainnetChainId),
            source: 'chainlist'
          };
          
          // Check if relation doesn't already exist
          const existingRelation = indexed.byChainId[testnetChainId].relations.find(
            r => r.kind === 'testnetOf' && r.chainId === Number(mainnetChainId)
          );
          
          if (!existingRelation) {
            indexed.byChainId[testnetChainId].relations.push(relation);
          }
        }
      }
    });
    
    // Third pass: Extract bridge URLs from parent.bridges in chainlist
    chainlist.forEach(chainData => {
      const chainId = chainData.chainId;
      
      // Skip if chainId is not valid
      if (chainId === undefined || chainId === null || Number.isNaN(Number(chainId))) {
        return;
      }
      
      // Extract bridge URLs from parent.bridges
      if (indexed.byChainId[chainId] && chainData.parent?.bridges) {
        mergeBridges(indexed.byChainId[chainId], chainData.parent.bridges);
      }
    });
  }
  
  // Merge The Graph registry data
  // The Graph uses caip2Id format (e.g., "eip155:1" for Ethereum mainnet)
  if (Array.isArray(theGraph?.networks)) {
    theGraph.networks.forEach(network => {
      processTheGraphNetwork(network, indexed, networkIdToChainId);
    });
  }
  
  // Add SLIP-0044 data
  if (slip44) {
    Object.keys(indexed.byChainId).forEach(chainId => {
      const chain = indexed.byChainId[chainId];
      if (chain.slip44 !== undefined && slip44[chain.slip44]) {
        chain.slip44Info = slip44[chain.slip44];
      }
    });
  }
  
  // Set default status to "active" for chains without status
  Object.keys(indexed.byChainId).forEach(chainId => {
    const chain = indexed.byChainId[chainId];
    if (!chain.status) {
      chain.status = 'active';
    }
  });
  
  // Add reverse relations: mainnetOf and parentOf
  Object.keys(indexed.byChainId).forEach(chainId => {
    const chain = indexed.byChainId[chainId];
    
    if (chain.relations && Array.isArray(chain.relations)) {
      chain.relations.forEach(relation => {
        // Add mainnetOf reverse relation for testnetOf
        if (relation.kind === 'testnetOf' && relation.chainId !== undefined) {
          const mainnetChain = indexed.byChainId[relation.chainId];
          if (mainnetChain) {
            // Check if mainnetOf relation doesn't already exist
            const existingMainnetOf = mainnetChain.relations.find(
              r => r.kind === 'mainnetOf' && r.chainId === Number.parseInt(chainId, 10)
            );
            
            if (!existingMainnetOf) {
              mainnetChain.relations.push({
                kind: 'mainnetOf',
                network: chain.name || chain.shortName || chainId.toString(),
                chainId: Number.parseInt(chainId, 10),
                source: relation.source
              });
            }
          }
        }
        
        // Add parentOf reverse relation for l2Of
        if (relation.kind === 'l2Of' && relation.chainId !== undefined) {
          const parentChain = indexed.byChainId[relation.chainId];
          if (parentChain) {
            // Check if parentOf relation doesn't already exist
            const existingParentOf = parentChain.relations.find(
              r => r.kind === 'parentOf' && r.chainId === Number.parseInt(chainId, 10)
            );
            
            if (!existingParentOf) {
              parentChain.relations.push({
                kind: 'parentOf',
                network: chain.name || chain.shortName || chainId.toString(),
                chainId: Number.parseInt(chainId, 10),
                source: relation.source
              });
            }
          }
        }
      });
    }
  });
  
  // Build all chains array
  indexed.all = Object.values(indexed.byChainId);
  
  return indexed;
}

/**
 * Load and cache all data sources
 */
export async function loadData() {
  console.log('Loading data from all sources...');

  const results = await Promise.allSettled([
    fetchData(DATA_SOURCES.theGraph),
    fetchData(DATA_SOURCES.chainlist),
    fetchData(DATA_SOURCES.chains),
    fetchData(DATA_SOURCES.slip44, 'text')
  ]);

  const theGraph = results[0].status === 'fulfilled' ? results[0].value : null;
  const chainlist = results[1].status === 'fulfilled' ? results[1].value : null;
  const chains = results[2].status === 'fulfilled' ? results[2].value : null;
  const slip44Text = results[3].status === 'fulfilled' ? results[3].value : null;

  // Log any failed sources
  const sourceNames = ['theGraph', 'chainlist', 'chains', 'slip44'];
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Failed to load ${sourceNames[i]}: ${result.reason?.message || result.reason}`);
    }
  });

  const slip44 = parseSLIP44(slip44Text);

  cachedData.theGraph = theGraph;
  cachedData.chainlist = chainlist;
  cachedData.chains = chains;
  cachedData.slip44 = slip44;
  cachedData.indexed = indexData(theGraph, chainlist, chains, slip44);
  cachedData.lastUpdated = new Date().toISOString();
  cachedData.rpcHealth = {};
  cachedData.lastRpcCheck = null;

  console.log(`Data loaded successfully. Total chains: ${cachedData.indexed.all.length}`);

  return cachedData;
}

/**
 * Get cached data
 */
export function getCachedData() {
  return cachedData;
}

/**
 * Search chains by various criteria
 */
export function searchChains(query) {
  if (!cachedData.indexed) {
    return [];
  }
  
  const results = [];
  const queryLower = query.toLowerCase();
  
  // Search by chain ID (exact match)
  const parsedChainId = Number.parseInt(query, 10);
  if (!Number.isNaN(parsedChainId)) {
    const chain = getChainById(parsedChainId);
    if (chain) {
      results.push(chain);
    }
  }
  
  // Search by name (partial match)
  cachedData.indexed.all.forEach(chain => {
    if (chain.name?.toLowerCase().includes(queryLower)) {
      if (!results.some(r => r.chainId === chain.chainId)) {
        results.push(getChainById(chain.chainId));
      }
    }
    if (chain.shortName?.toLowerCase().includes(queryLower)) {
      if (!results.some(r => r.chainId === chain.chainId)) {
        results.push(getChainById(chain.chainId));
      }
    }
  });
  
  return results;
}

/**
 * Get chain by ID (returns full data including rpc, relations, theGraph)
 */
function getChainByIdRaw(chainId) {
  if (!cachedData.indexed) {
    return null;
  }
  
  return cachedData.indexed.byChainId[chainId] || null;
}

/**
 * Transform chain to API format (without rpc, relations, and with flattened theGraph fields)
 */
function transformChain(chain) {
  if (!chain) {
    return null;
  }
  
  // Create transformed chain object
  const transformedChain = {
    chainId: chain.chainId,
    name: chain.name,
    shortName: chain.shortName,
  };
  
  // Add theGraph fields if available
  if (chain.theGraph) {
    transformedChain['theGraph-id'] = chain.theGraph.id;
    transformedChain.fullName = chain.theGraph.fullName;
    transformedChain.caip2Id = chain.theGraph.caip2Id;
    if (chain.theGraph.aliases) {
      transformedChain.aliases = chain.theGraph.aliases;
    }
  }
  
  // Add other fields
  if (chain.nativeCurrency) {
    transformedChain.nativeCurrency = chain.nativeCurrency;
  }
  if (chain.explorers) {
    transformedChain.explorers = chain.explorers;
  }
  if (chain.infoURL) {
    transformedChain.infoURL = chain.infoURL;
  }
  if (chain.sources) {
    transformedChain.sources = chain.sources;
  }
  if (chain.tags) {
    transformedChain.tags = chain.tags;
  }
  if (chain.status) {
    transformedChain.status = chain.status;
  }
  if (chain.bridges) {
    transformedChain.bridges = chain.bridges;
  }
  
  return transformedChain;
}

/**
 * Get chain by ID (transformed format without rpc, relations, and with flattened theGraph fields)
 */
export function getChainById(chainId) {
  const chain = getChainByIdRaw(chainId);
  return transformChain(chain);
}

/**
 * Get all chains (transformed format without rpc, relations, and with flattened theGraph fields)
 */
export function getAllChains() {
  if (!cachedData.indexed) {
    return [];
  }
  
  // Transform all chains using the helper function
  return cachedData.indexed.all.map(transformChain);
}

/**
 * Get all relations from all chains
 * Returns relations with nested structure: { parentChainId: { childChainId: {...} } }
 */
export function getAllRelations() {
  if (!cachedData.indexed) {
    return {};
  }
  
  const allRelations = {};
  
  // Allowed relation kinds (parentOf will be renamed to l1Of in the output)
  const allowedKinds = new Set(['l2Of', 'parentOf', 'testnetOf', 'mainnetOf']);
  
  cachedData.indexed.all.forEach(chain => {
    if (chain.relations?.length > 0) {
      chain.relations.forEach(relation => {
        // Only include allowed relation kinds and those with chainId
        if (allowedKinds.has(relation.kind) && relation.chainId !== undefined) {
          let parentChainId, childChainId, parentName, childName;
          
          // Rename parentOf to l1Of
          let kind = relation.kind;
          if (kind === 'parentOf') {
            kind = 'l1Of';
          }
          
          // Determine parent and child based on relation type
          if (kind === 'l1Of' || kind === 'mainnetOf') {
            // For l1Of (parentOf) and mainnetOf: the chain having the relation is the parent
            parentChainId = chain.chainId;
            childChainId = relation.chainId;
            parentName = chain.name;
            const childChain = cachedData.indexed.byChainId[childChainId];
            childName = childChain ? childChain.name : relation.network;
          } else {
            // For l2Of and testnetOf: the chain having the relation is the child
            childChainId = chain.chainId;
            parentChainId = relation.chainId;
            childName = chain.name;
            const parentChain = cachedData.indexed.byChainId[parentChainId];
            parentName = parentChain ? parentChain.name : relation.network;
          }
          
          // Use nested structure: parentChainId -> childChainId -> relation data
          const parentKey = String(parentChainId);
          const childKey = String(childChainId);
          
          // Initialize parent entry if it doesn't exist
          if (!allRelations[parentKey]) {
            allRelations[parentKey] = {};
          }
          
          // Store relation under child chainId within parent's object
          allRelations[parentKey][childKey] = {
            parentName,
            kind,
            childName,
            chainId: childChainId,
            source: relation.source
          };
        }
      });
    }
  });
  
  return allRelations;
}

/**
 * Get relations for a specific chain by ID
 */
export function getRelationsById(chainId) {
  if (!cachedData.indexed) {
    return null;
  }
  
  const chain = cachedData.indexed.byChainId[chainId];
  
  if (!chain) {
    return null;
  }
  
  return {
    chainId: chain.chainId,
    chainName: chain.name,
    relations: chain.relations || []
  };
}

/**
 * Extract endpoints from a chain (helper function)
 */
function extractEndpoints(chain) {
  if (!chain) {
    return null;
  }
  
  const endpoints = {
    chainId: chain.chainId,
    name: chain.name,
    rpc: chain.rpc || [],
    firehose: [],
    substreams: []
  };
  
  // Extract firehose and substreams from theGraph services
  if (chain.theGraph?.services) {
    if (chain.theGraph.services.firehose) {
      endpoints.firehose = chain.theGraph.services.firehose;
    }
    if (chain.theGraph.services.substreams) {
      endpoints.substreams = chain.theGraph.services.substreams;
    }
  }
  
  return endpoints;
}

/**
 * Get endpoints for a specific chain by ID
 */
export function getEndpointsById(chainId) {
  const chain = getChainByIdRaw(chainId);
  return extractEndpoints(chain);
}

/**
 * Get endpoints for all chains
 */
export function getAllEndpoints() {
  if (!cachedData.indexed) {
    return [];
  }
  
  return cachedData.indexed.all.map(extractEndpoints);
}

/**
 * Normalize an RPC entry to a plain URL string
 */
function normalizeRpcUrl(rpcEntry) {
  if (!rpcEntry) return null;
  if (typeof rpcEntry === 'string') return rpcEntry;
  if (typeof rpcEntry === 'object' && rpcEntry.url) return rpcEntry.url;
  return null;
}

/**
 * Convert a block height (hex or number) to a numeric value
 */
function parseBlockHeight(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  
  if (typeof value === 'string') {
    if (value.startsWith('0x')) {
      const parsed = Number.parseInt(value, 16);
      return Number.isNaN(parsed) ? null : parsed;
    }
    
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  
  return null;
}

/**
 * Check a single RPC endpoint for client version and latest block height
 */
async function checkRpcEndpoint(url) {
  const result = {
    url,
    ok: false,
    clientVersion: null,
    blockHeight: null,
    error: null
  };
  
  if (!url?.startsWith('http')) {
    result.error = 'Unsupported RPC URL';
    return result;
  }
  
  if (url.includes('${')) {
    result.error = 'RPC URL requires API key substitution';
    return result;
  }
  
  try {
    const [clientVersion, blockNumber] = await Promise.all([
      jsonRpcCall(url, 'web3_clientVersion', { timeoutMs: RPC_CHECK_TIMEOUT_MS }),
      jsonRpcCall(url, 'eth_blockNumber', { timeoutMs: RPC_CHECK_TIMEOUT_MS })
    ]);
    
    result.clientVersion = clientVersion || null;
    result.blockHeight = parseBlockHeight(blockNumber);
    result.ok = Boolean(result.clientVersion) && result.blockHeight !== null;
  } catch (error) {
    result.error = error.message;
  }
  
  return result;
}

/**
 * Run RPC health checks across all endpoints
 */
export async function runRpcHealthCheck() {
  if (!cachedData.indexed) {
    console.warn('RPC health check skipped: data not loaded');
    return;
  }
  
  const dataVersion = cachedData.lastUpdated;
  const endpoints = getAllEndpoints();
  const tasks = [];
  const results = {};
  
  endpoints.forEach(({ chainId, rpc }) => {
    const normalizedUrls = (rpc || []).map(normalizeRpcUrl).filter(Boolean);
    const validUrls = Array.from(new Set(normalizedUrls)).filter(url => url.startsWith('http'));
    
    if (validUrls.length === 0) {
      return;
    }
    
    validUrls.forEach(url => tasks.push({ chainId, url }));
    if (!results[chainId]) {
      results[chainId] = [];
    }
  });
  
  cachedData.rpcHealth = {};
  cachedData.lastRpcCheck = null;
  
  if (tasks.length === 0) {
    console.warn('RPC health check skipped: no RPC endpoints found');
    return;
  }
  
  let taskIndex = 0;
  const worker = async () => {
    while (taskIndex < tasks.length) {
      const current = taskIndex++;
      const task = tasks[current];
      const status = await checkRpcEndpoint(task.url);
      
      if (!results[task.chainId]) {
        results[task.chainId] = [];
      }
      
      results[task.chainId].push(status);
    }
  };
  
  const workerCount = Math.min(RPC_CHECK_CONCURRENCY, tasks.length);
  const workers = Array.from({ length: workerCount }, worker);
  await Promise.all(workers);
  
  if (cachedData.lastUpdated !== dataVersion) {
    console.warn('RPC health check skipped: data changed during run');
    return;
  }
  
  cachedData.rpcHealth = results;
  cachedData.lastRpcCheck = new Date().toISOString();
  console.log(`RPC health check completed: ${tasks.length} endpoints tested across ${Object.keys(results).length} chains`);
}

/**
 * Start the RPC health check in the background (no-op if already running)
 */
export function startRpcHealthCheck() {
  if (rpcCheckInProgress) {
    rpcCheckPending = true;
    return;
  }
  
  rpcCheckInProgress = true;
  rpcCheckPending = false;
  runRpcHealthCheck()
    .catch(error => {
      console.error('RPC health check failed:', error.message || error);
    })
    .finally(() => {
      rpcCheckInProgress = false;
      
      if (rpcCheckPending) {
        startRpcHealthCheck();
      }
    });
}

// Helper function to get chain from different sources
function getChainFromSource(chainId, source) {
  if (source === 'theGraph') {
    return cachedData.theGraph.networks?.find(n => {
      if (n.caip2Id) {
        const match = n.caip2Id.match(/^eip155:(\d+)$/);
        return match && Number.parseInt(match[1], 10) === chainId;
      }
      return false;
    });
  } else if (source === 'chainlist') {
    return cachedData.chainlist?.find(c => c.chainId === chainId);
  } else if (source === 'chains') {
    return cachedData.chains?.find(c => c.chainId === chainId);
  }
  return null;
}

// Rule 1: Check for relation conflicts
function validateRule1RelationConflicts(chain, errors) {
  if (!chain.relations || chain.relations.length === 0) return;

  const graphRelations = chain.relations.filter(r => r.source === 'theGraph');

  graphRelations.forEach(graphRel => {
    if (graphRel.kind === 'testnetOf' && graphRel.chainId) {
      if (!chain.tags.includes('Testnet')) {
        errors.push({
          rule: 1,
          chainId: chain.chainId,
          chainName: chain.name,
          type: 'relation_tag_conflict',
          message: `Chain ${chain.chainId} (${chain.name}) has testnetOf relation but is not tagged as Testnet`,
          graphRelation: graphRel
        });
      }

      const chainlistChain = getChainFromSource(chain.chainId, 'chainlist');
      if (chainlistChain?.isTestnet === false) {
        errors.push({
          rule: 1,
          chainId: chain.chainId,
          chainName: chain.name,
          type: 'relation_source_conflict',
          message: `Chain ${chain.chainId} (${chain.name}) has testnetOf relation in theGraph but isTestnet=false in chainlist`,
          graphRelation: graphRel,
          chainlistData: { isTestnet: chainlistChain.isTestnet }
        });
      }
    }

    if (graphRel.kind === 'l2Of' && graphRel.chainId) {
      if (!chain.tags.includes('L2')) {
        errors.push({
          rule: 1,
          chainId: chain.chainId,
          chainName: chain.name,
          type: 'relation_tag_conflict',
          message: `Chain ${chain.chainId} (${chain.name}) has l2Of relation but is not tagged as L2`,
          graphRelation: graphRel
        });
      }
    }
  });
}

// Rule 2: Check slip44 testnet mismatch
function validateRule2Slip44Mismatch(chain, errors) {
  const chainlistChain = getChainFromSource(chain.chainId, 'chainlist');
  const chainsChain = getChainFromSource(chain.chainId, 'chains');

  if (chainlistChain?.slip44 === 1 && chainlistChain.isTestnet === false) {
    errors.push({
      rule: 2,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'slip44_testnet_mismatch',
      message: `Chain ${chain.chainId} (${chain.name}) has slip44=1 (testnet indicator) but isTestnet=false in chainlist`,
      slip44: chainlistChain.slip44,
      isTestnet: chainlistChain.isTestnet
    });
  }

  if (chainsChain?.slip44 === 1 && !chain.tags.includes('Testnet')) {
    errors.push({
      rule: 2,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'slip44_testnet_mismatch',
      message: `Chain ${chain.chainId} (${chain.name}) has slip44=1 (testnet indicator) in chains.json but not tagged as Testnet`,
      slip44: chainsChain.slip44,
      tags: chain.tags
    });
  }
}

// Rule 3: Check name testnet mismatch
function validateRule3NameTestnetMismatch(chain, errors) {
  const fullName = chain.theGraph?.fullName || chain.name || '';
  const nameLower = fullName.toLowerCase();

  if ((nameLower.includes('testnet') || nameLower.includes('devnet')) && !chain.tags.includes('Testnet')) {
    errors.push({
      rule: 3,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'name_testnet_mismatch',
      message: `Chain ${chain.chainId} (${chain.name}) has "Testnet" or "Devnet" in full name "${fullName}" but not tagged as Testnet`,
      fullName: fullName,
      tags: chain.tags
    });
  }
}

// Rule 4: Check sepolia/hoodie without L2 tag or relations
function validateRule4SepoliaHoodie(chain, errors) {
  const fullName = chain.theGraph?.fullName || chain.name || '';
  const nameLower = fullName.toLowerCase();

  if (nameLower.includes('sepolia') || nameLower.includes('hoodie')) {
    const hasL2Tag = chain.tags.includes('L2');
    const hasRelations = chain.relations && chain.relations.length > 0;

    if (!hasL2Tag && !hasRelations) {
      errors.push({
        rule: 4,
        chainId: chain.chainId,
        chainName: chain.name,
        type: 'sepolia_hoodie_no_l2_or_relations',
        message: `Chain ${chain.chainId} (${chain.name}) contains "sepolia" or "hoodie" but not tagged as L2 and has no relations`,
        fullName: fullName,
        tags: chain.tags,
        relations: chain.relations
      });
    }
  }
}

// Rule 5: Check status conflicts across sources
function validateRule5StatusConflicts(chain, errors) {
  const chainlistChain = getChainFromSource(chain.chainId, 'chainlist');
  const chainsChain = getChainFromSource(chain.chainId, 'chains');

  const statuses = [];
  if (chainlistChain?.status) {
    statuses.push({ source: 'chainlist', status: chainlistChain.status });
  }
  if (chainsChain?.status) {
    statuses.push({ source: 'chains', status: chainsChain.status });
  }

  const deprecatedInSources = statuses.filter(s => s.status === 'deprecated');
  const activeInSources = statuses.filter(s => s.status === 'active');

  if (deprecatedInSources.length > 0 && activeInSources.length > 0) {
    errors.push({
      rule: 5,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'status_conflict',
      message: `Chain ${chain.chainId} (${chain.name}) has conflicting status across sources`,
      statuses: statuses
    });
  }

  return statuses;
}

// Rule 6: Check Goerli not deprecated
function validateRule6GoerliDeprecated(chain, statuses, errors) {
  const fullName = chain.theGraph?.fullName || chain.name || '';
  const nameLower = fullName.toLowerCase();

  if (nameLower.includes('goerli')) {
    const chainlistChain = getChainFromSource(chain.chainId, 'chainlist');
    const chainsChain = getChainFromSource(chain.chainId, 'chains');

    const isDeprecated = chain.status === 'deprecated' ||
      chainlistChain?.status === 'deprecated' ||
      chainsChain?.status === 'deprecated';

    if (!isDeprecated) {
      errors.push({
        rule: 6,
        chainId: chain.chainId,
        chainName: chain.name,
        type: 'goerli_not_deprecated',
        message: `Chain ${chain.chainId} (${chain.name}) contains "Goerli" but is not marked as deprecated`,
        fullName: fullName,
        status: chain.status,
        statusInSources: statuses
      });
    }
  }
}

// Validate a single chain
function validateChain(chain, errors) {
  validateRule1RelationConflicts(chain, errors);
  validateRule2Slip44Mismatch(chain, errors);
  validateRule3NameTestnetMismatch(chain, errors);
  validateRule4SepoliaHoodie(chain, errors);
  const statuses = validateRule5StatusConflicts(chain, errors);
  validateRule6GoerliDeprecated(chain, statuses, errors);
}

/**
 * Validate chain data for potential human errors
 * Returns an object with validation results categorized by error type
 */
export function validateChainData() {
  if (!cachedData.indexed || !cachedData.theGraph || !cachedData.chainlist || !cachedData.chains) {
    return {
      error: 'Data not loaded. Please reload data sources first.',
      errors: []
    };
  }

  const errors = [];

  // Iterate through all indexed chains
  Object.values(cachedData.indexed.byChainId).forEach(chain => {
    validateChain(chain, errors);
  });
  
  // Group errors by rule
  const errorsByRule = {
    rule1_relation_conflicts: errors.filter(e => e.rule === 1),
    rule2_slip44_testnet_mismatch: errors.filter(e => e.rule === 2),
    rule3_name_testnet_mismatch: errors.filter(e => e.rule === 3),
    rule4_sepolia_hoodie_issues: errors.filter(e => e.rule === 4),
    rule5_status_conflicts: errors.filter(e => e.rule === 5),
    rule6_goerli_not_deprecated: errors.filter(e => e.rule === 6)
  };
  
  return {
    totalErrors: errors.length,
    errorsByRule: errorsByRule,
    summary: {
      rule1: errorsByRule.rule1_relation_conflicts.length,
      rule2: errorsByRule.rule2_slip44_testnet_mismatch.length,
      rule3: errorsByRule.rule3_name_testnet_mismatch.length,
      rule4: errorsByRule.rule4_sepolia_hoodie_issues.length,
      rule5: errorsByRule.rule5_status_conflicts.length,
      rule6: errorsByRule.rule6_goerli_not_deprecated.length
    },
    allErrors: errors
  };
}
