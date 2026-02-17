import {
  DATA_SOURCE_THE_GRAPH, DATA_SOURCE_CHAINLIST,
  DATA_SOURCE_CHAINS, DATA_SOURCE_SLIP44,
  RPC_CHECK_TIMEOUT_MS, RPC_CHECK_CONCURRENCY
} from './config.js';
import { proxyFetch } from './fetchUtil.js';

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
async function fetchData(url, format = 'json') {
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
function parseSLIP44(markdown) {
  if (!markdown) return {};
  
  const slip44Data = {};
  const lines = markdown.split('\n');
  let inTable = false;
  
  for (const line of lines) {
    // Detect table rows (format: | Coin type | Path component | Symbol | Coin |)
    if (line.trim().startsWith('|') && line.includes('|')) {
      const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);
      
      // Skip header and separator rows
      if (cells[0] === 'Coin type' || cells[0].includes('-')) {
        inTable = true;
        continue;
      }
      
      if (inTable && cells.length >= 4) {
        const coinType = cells[0];
        const pathComponent = cells[1];
        const symbol = cells[2];
        const coin = cells[3];
        
        const coinTypeNum = Number.parseInt(coinType, 10);
        if (coinType && !Number.isNaN(coinTypeNum)) {
          slip44Data[coinTypeNum] = {
            coinType: coinTypeNum,
            pathComponent,
            symbol,
            coin
          };
        }
      }
    }
  }
  
  return slip44Data;
}

/**
 * Build a mapping of network IDs to chain IDs from The Graph data
 */
function buildNetworkIdToChainIdMap(theGraph) {
  const networkIdToChainId = {};
  
  if (theGraph && theGraph.networks && Array.isArray(theGraph.networks)) {
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
  return bridge && bridge.url ? bridge.url : null;
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
 * Index all data into a searchable structure
 */
function indexData(theGraph, chainlist, chains, slip44) {
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
      const chainId = chain.chainId;
      
      // Check for L2 parent relation
      if (chainId !== undefined && chain.parent && chain.parent.type === 'L2') {
        // Extract parent chain ID from format like "eip155-11155111"
        if (chain.parent.chain) {
          const match = chain.parent.chain.match(/^eip155-(\d+)$/);
          if (match) {
            const parentChainId = Number.parseInt(match[1], 10);
            
            // Ensure the chain exists in indexed data
            if (indexed.byChainId[chainId]) {
              // Add L2 tag
              if (!indexed.byChainId[chainId].tags.includes('L2')) {
                indexed.byChainId[chainId].tags.push('L2');
              }
              
              // Add l2Of relation
              const relation = {
                kind: 'l2Of',
                network: chain.parent.chain,
                chainId: parentChainId,
                source: 'chains'
              };
              
              // Check if relation doesn't already exist
              const existingRelation = indexed.byChainId[chainId].relations.find(
                r => r.kind === 'l2Of' && r.chainId === parentChainId
              );
              
              if (!existingRelation) {
                indexed.byChainId[chainId].relations.push(relation);
              }
              
              // Extract bridge URLs from parent.bridges
              mergeBridges(indexed.byChainId[chainId], chain.parent.bridges);
            }
          }
        }
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
      
      if (!indexed.byChainId[chainId]) {
        indexed.byChainId[chainId] = {
          chainId: Number(chainId),
          name: chainData.name,
          rpc: chainData.rpc || [],
          sources: ['chainlist'],
          tags: [],
          relations: [],
          status: chainData.status || 'active' // Default to 'active' if not present
        };
      } else {
        // Merge RPC data
        if (chainData.rpc && Array.isArray(chainData.rpc)) {
          if (!indexed.byChainId[chainId].rpc) {
            indexed.byChainId[chainId].rpc = [];
          }
          
          // Build a set of existing RPCs for comparison
          // Need to handle both string and object formats
          const existingRpcUrls = new Set();
          indexed.byChainId[chainId].rpc.forEach(rpc => {
            const url = typeof rpc === 'string' ? rpc : rpc.url;
            if (url) existingRpcUrls.add(url);
          });
          
          chainData.rpc.forEach(rpc => {
            const url = typeof rpc === 'string' ? rpc : rpc.url;
            if (url && !existingRpcUrls.has(url)) {
              indexed.byChainId[chainId].rpc.push(rpc);
              existingRpcUrls.add(url);
            }
          });
        }
        if (!indexed.byChainId[chainId].sources.includes('chainlist')) {
          indexed.byChainId[chainId].sources.push('chainlist');
        }
        // Merge status if not already present
        if (chainData.status && !indexed.byChainId[chainId].status) {
          indexed.byChainId[chainId].status = chainData.status;
        }
      }
      
      // Check for testnet based on slip44 and isTestnet flag
      if ((chainData.slip44 === 1 || chainData.isTestnet === true) && indexed.byChainId[chainId]) {
        if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
          indexed.byChainId[chainId].tags.push('Testnet');
        }
      }
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
      if (indexed.byChainId[chainId] && chainData.parent && chainData.parent.bridges) {
        mergeBridges(indexed.byChainId[chainId], chainData.parent.bridges);
      }
    });
  }
  
  // Merge The Graph registry data
  // The Graph uses caip2Id format (e.g., "eip155:1" for Ethereum mainnet)
  if (theGraph && theGraph.networks && Array.isArray(theGraph.networks)) {
    theGraph.networks.forEach(network => {
      let chainId = null;
      
      // Extract chain ID from caip2Id (format: "eip155:1")
      if (network.caip2Id) {
        const match = network.caip2Id.match(/^eip155:(\d+)$/);
        if (match) {
          chainId = Number.parseInt(match[1], 10);
        }
      }
      
      // Process beacon chains separately (they don't get their own chain entry)
      const isBeaconChain = network.caip2Id && network.caip2Id.startsWith('beacon:');
      
      if (chainId !== null) {
        if (!indexed.byChainId[chainId]) {
          indexed.byChainId[chainId] = {
            chainId,
            // Use fullName for display, fallback to shortName, then id (The Graph network identifier)
            name: network.fullName || network.shortName || network.id || 'Unknown',
            shortName: network.shortName,
            nativeCurrency: { symbol: network.nativeToken },
            rpc: network.rpcUrls || [],
            explorers: network.explorerUrls || [],
            sources: ['theGraph'],
            tags: [],
            relations: [],
            status: 'active' // Default to 'active' for The Graph chains
          };
        } else {
          if (!indexed.byChainId[chainId].sources.includes('theGraph')) {
            indexed.byChainId[chainId].sources.push('theGraph');
          }
          // Merge RPC URLs - ensure rpc array exists
          if (network.rpcUrls && Array.isArray(network.rpcUrls)) {
            if (!indexed.byChainId[chainId].rpc) {
              indexed.byChainId[chainId].rpc = [];
            }
            
            // Build a set of existing RPC URLs for comparison
            // Need to handle both string and object formats
            const existingRpcUrls = new Set();
            indexed.byChainId[chainId].rpc.forEach(rpc => {
              const url = typeof rpc === 'string' ? rpc : rpc.url;
              if (url) existingRpcUrls.add(url);
            });
            
            network.rpcUrls.forEach(rpc => {
              const url = typeof rpc === 'string' ? rpc : rpc.url;
              if (url && !existingRpcUrls.has(url)) {
                indexed.byChainId[chainId].rpc.push(rpc);
                existingRpcUrls.add(url);
              }
            });
          }
          
          // Ensure tags and relations arrays exist for chains from other sources
          if (!indexed.byChainId[chainId].tags) {
            indexed.byChainId[chainId].tags = [];
          }
          if (!indexed.byChainId[chainId].relations) {
            indexed.byChainId[chainId].relations = [];
          }
        }
        
        // Process network type for testnet marking
        if (network.networkType === 'testnet') {
          if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
            indexed.byChainId[chainId].tags.push('Testnet');
          }
        }
        
        // Process relations
        if (network.relations && Array.isArray(network.relations)) {
          network.relations.forEach(relation => {
            const { kind, network: targetNetworkId } = relation;
            
            // Convert network ID to chain ID
            const targetChainId = networkIdToChainId[targetNetworkId];
            
            // Store relation with chain ID if available, otherwise with network ID
            const relationData = {
              kind,
              network: targetNetworkId,
              ...(targetChainId !== undefined && { chainId: targetChainId }),
              source: 'theGraph'
            };
            
            indexed.byChainId[chainId].relations.push(relationData);
            
            // Add tags based on relation kind
            if (kind === 'testnetOf') {
              if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
                indexed.byChainId[chainId].tags.push('Testnet');
              }
            } else if (kind === 'l2Of') {
              if (!indexed.byChainId[chainId].tags.includes('L2')) {
                indexed.byChainId[chainId].tags.push('L2');
              }
            } else if (kind === 'beaconOf') {
              // Add "Beacon" tag to the target chain
              addBeaconTagToTargetChain(indexed, targetChainId);
            }
          });
        }
        
        // Add The Graph specific data
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
        
        // Add to name index
        const nameLower = (network.fullName || network.shortName || '').toLowerCase();
        if (nameLower && !indexed.byName[nameLower]) {
          indexed.byName[nameLower] = [];
        }
        if (nameLower && !indexed.byName[nameLower].includes(chainId)) {
          indexed.byName[nameLower].push(chainId);
        }
      } else if (isBeaconChain) {
        // Process beacon chains to add "Beacon" tag to their target chains
        if (network.relations && Array.isArray(network.relations)) {
          network.relations.forEach(relation => {
            const { kind, network: targetNetworkId } = relation;
            
            if (kind === 'beaconOf') {
              const targetChainId = networkIdToChainId[targetNetworkId];
              addBeaconTagToTargetChain(indexed, targetChainId);
            }
          });
        }
      }
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
    if (chain.name && chain.name.toLowerCase().includes(queryLower)) {
      if (!results.find(r => r.chainId === chain.chainId)) {
        results.push(getChainById(chain.chainId));
      }
    }
    if (chain.shortName && chain.shortName.toLowerCase().includes(queryLower)) {
      if (!results.find(r => r.chainId === chain.chainId)) {
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
  const allowedKinds = ['l2Of', 'parentOf', 'testnetOf', 'mainnetOf'];
  
  cachedData.indexed.all.forEach(chain => {
    if (chain.relations && Array.isArray(chain.relations) && chain.relations.length > 0) {
      chain.relations.forEach(relation => {
        // Only include allowed relation kinds and those with chainId
        if (allowedKinds.includes(relation.kind) && relation.chainId !== undefined) {
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
  if (chain.theGraph && chain.theGraph.services) {
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
 * Perform a JSON-RPC call with a timeout
 */
async function performJsonRpc(url, method) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RPC_CHECK_TIMEOUT_MS);
  
  try {
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: []
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const body = await response.json();
    if (body.error) {
      const message = body.error.message || 'RPC error';
      throw new Error(message);
    }
    
    return body.result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('RPC request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
  
  if (!url || !url.startsWith('http')) {
    result.error = 'Unsupported RPC URL';
    return result;
  }
  
  if (url.includes('${')) {
    result.error = 'RPC URL requires API key substitution';
    return result;
  }
  
  try {
    const [clientVersion, blockNumber] = await Promise.all([
      performJsonRpc(url, 'web3_clientVersion'),
      performJsonRpc(url, 'eth_blockNumber')
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
  
  // Helper function to get chain from different sources
  const getChainFromSource = (chainId, source) => {
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
  };

  // Build network ID to chain ID map for relation checking
  const networkIdToChainId = buildNetworkIdToChainIdMap(cachedData.theGraph);

  // Iterate through all indexed chains
  Object.values(cachedData.indexed.byChainId).forEach(chain => {
    const chainId = chain.chainId;
    
    // Rule 1: Conflicts between graph relations and other sources
    // Assume graph relations are always true, check if other sources conflict
    if (chain.relations && chain.relations.length > 0) {
      const graphRelations = chain.relations.filter(r => r.source === 'theGraph');
      
      graphRelations.forEach(graphRel => {
        // Check testnetOf relation
        if (graphRel.kind === 'testnetOf' && graphRel.chainId) {
          // Check if chain is marked as Testnet
          if (!chain.tags.includes('Testnet')) {
            errors.push({
              rule: 1,
              chainId: chainId,
              chainName: chain.name,
              type: 'relation_tag_conflict',
              message: `Chain ${chainId} (${chain.name}) has testnetOf relation but is not tagged as Testnet`,
              graphRelation: graphRel
            });
          }
          
          // Check if other sources have conflicting data
          const chainlistChain = getChainFromSource(chainId, 'chainlist');
          if (chainlistChain && chainlistChain.isTestnet === false) {
            errors.push({
              rule: 1,
              chainId: chainId,
              chainName: chain.name,
              type: 'relation_source_conflict',
              message: `Chain ${chainId} (${chain.name}) has testnetOf relation in theGraph but isTestnet=false in chainlist`,
              graphRelation: graphRel,
              chainlistData: { isTestnet: chainlistChain.isTestnet }
            });
          }
        }
        
        // Check l2Of relation
        if (graphRel.kind === 'l2Of' && graphRel.chainId) {
          // Check if chain is marked as L2
          if (!chain.tags.includes('L2')) {
            errors.push({
              rule: 1,
              chainId: chainId,
              chainName: chain.name,
              type: 'relation_tag_conflict',
              message: `Chain ${chainId} (${chain.name}) has l2Of relation but is not tagged as L2`,
              graphRelation: graphRel
            });
          }
        }
      });
    }
    
    // Rule 2: slip44 = 1 but isTestnet = false
    const chainlistChain = getChainFromSource(chainId, 'chainlist');
    const chainsChain = getChainFromSource(chainId, 'chains');
    
    if (chainlistChain && chainlistChain.slip44 === 1 && chainlistChain.isTestnet === false) {
      errors.push({
        rule: 2,
        chainId: chainId,
        chainName: chain.name,
        type: 'slip44_testnet_mismatch',
        message: `Chain ${chainId} (${chain.name}) has slip44=1 (testnet indicator) but isTestnet=false in chainlist`,
        slip44: chainlistChain.slip44,
        isTestnet: chainlistChain.isTestnet
      });
    }
    
    if (chainsChain && chainsChain.slip44 === 1 && !chain.tags.includes('Testnet')) {
      errors.push({
        rule: 2,
        chainId: chainId,
        chainName: chain.name,
        type: 'slip44_testnet_mismatch',
        message: `Chain ${chainId} (${chain.name}) has slip44=1 (testnet indicator) in chains.json but not tagged as Testnet`,
        slip44: chainsChain.slip44,
        tags: chain.tags
      });
    }
    
    // Rule 3: Chain full name includes "Testnet" or "Devnet" but identifying as Mainnet
    const fullName = chain.theGraph?.fullName || chain.name || '';
    const nameLower = fullName.toLowerCase();
    
    if ((nameLower.includes('testnet') || nameLower.includes('devnet')) && !chain.tags.includes('Testnet')) {
      errors.push({
        rule: 3,
        chainId: chainId,
        chainName: chain.name,
        type: 'name_testnet_mismatch',
        message: `Chain ${chainId} (${chain.name}) has "Testnet" or "Devnet" in full name "${fullName}" but not tagged as Testnet`,
        fullName: fullName,
        tags: chain.tags
      });
    }
    
    // Rule 4: Chain name contains "sepolia" or "hoodie" but not identifying as L2 or no relations with other networks
    if (nameLower.includes('sepolia') || nameLower.includes('hoodie')) {
      const hasL2Tag = chain.tags.includes('L2');
      const hasRelations = chain.relations && chain.relations.length > 0;
      
      if (!hasL2Tag && !hasRelations) {
        errors.push({
          rule: 4,
          chainId: chainId,
          chainName: chain.name,
          type: 'sepolia_hoodie_no_l2_or_relations',
          message: `Chain ${chainId} (${chain.name}) contains "sepolia" or "hoodie" but not tagged as L2 and has no relations`,
          fullName: fullName,
          tags: chain.tags,
          relations: chain.relations
        });
      }
    }
    
    // Rule 5: Status "deprecated" conflicts in different sources
    const statuses = [];
    
    if (chainlistChain && chainlistChain.status) {
      statuses.push({ source: 'chainlist', status: chainlistChain.status });
    }
    if (chainsChain && chainsChain.status) {
      statuses.push({ source: 'chains', status: chainsChain.status });
    }
    
    // Check for conflicts
    const deprecatedInSources = statuses.filter(s => s.status === 'deprecated');
    const activeInSources = statuses.filter(s => s.status === 'active');
    
    if (deprecatedInSources.length > 0 && activeInSources.length > 0) {
      errors.push({
        rule: 5,
        chainId: chainId,
        chainName: chain.name,
        type: 'status_conflict',
        message: `Chain ${chainId} (${chain.name}) has conflicting status across sources`,
        statuses: statuses
      });
    }
    
    // Rule 6: Chains containing "Goerli" not marked as deprecated
    if (nameLower.includes('goerli')) {
      const isDeprecated = chain.status === 'deprecated' || 
                          (chainlistChain && chainlistChain.status === 'deprecated') ||
                          (chainsChain && chainsChain.status === 'deprecated');
      
      if (!isDeprecated) {
        errors.push({
          rule: 6,
          chainId: chainId,
          chainName: chain.name,
          type: 'goerli_not_deprecated',
          message: `Chain ${chainId} (${chain.name}) contains "Goerli" but is not marked as deprecated`,
          fullName: fullName,
          status: chain.status,
          statusInSources: statuses
        });
      }
    }
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
