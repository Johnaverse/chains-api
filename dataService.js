import fetch from 'node-fetch';

// Data source URLs
const DATA_SOURCES = {
  theGraph: 'https://raw.githubusercontent.com/Johnaverse/networks-registry/refs/heads/main/public/TheGraphNetworksRegistry.json',
  chainlist: 'https://chainlist.org/rpcs.json',
  chains: 'https://chainid.network/chains.json',
  slip44: 'https://raw.githubusercontent.com/satoshilabs/slips/master/slip-0044.md'
};

// Cache for data
let cachedData = {
  theGraph: null,
  chainlist: null,
  chains: null,
  slip44: null,
  indexed: null,
  lastUpdated: null
};

/**
 * Fetch data from a URL with error handling
 */
async function fetchData(url, format = 'json') {
  try {
    const response = await fetch(url);
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
        
        if (coinType && !isNaN(coinType)) {
          const coinTypeNum = parseInt(coinType);
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
          const chainId = parseInt(match[1]);
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
    
    // Process L2 relations from parent field in chains.json
    chains.forEach(chain => {
      const chainId = chain.chainId;
      
      // Check for L2 parent relation
      if (chainId !== undefined && chain.parent && chain.parent.type === 'L2') {
        // Extract parent chain ID from format like "eip155-11155111"
        if (chain.parent.chain) {
          const match = chain.parent.chain.match(/^eip155-(\d+)$/);
          if (match) {
            const parentChainId = parseInt(match[1]);
            
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
      if (chainId === undefined || chainId === null || isNaN(chainId)) {
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
      if (testnetChainId === undefined || testnetChainId === null || isNaN(testnetChainId)) {
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
          chainId = parseInt(match[1]);
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
              r => r.kind === 'mainnetOf' && r.chainId === parseInt(chainId)
            );
            
            if (!existingMainnetOf) {
              mainnetChain.relations.push({
                kind: 'mainnetOf',
                network: chain.name || chain.shortName || chainId.toString(),
                chainId: parseInt(chainId),
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
              r => r.kind === 'parentOf' && r.chainId === parseInt(chainId)
            );
            
            if (!existingParentOf) {
              parentChain.relations.push({
                kind: 'parentOf',
                network: chain.name || chain.shortName || chainId.toString(),
                chainId: parseInt(chainId),
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
  
  const [theGraph, chainlist, chains, slip44Text] = await Promise.all([
    fetchData(DATA_SOURCES.theGraph),
    fetchData(DATA_SOURCES.chainlist),
    fetchData(DATA_SOURCES.chains),
    fetchData(DATA_SOURCES.slip44, 'text')
  ]);
  
  const slip44 = parseSLIP44(slip44Text);
  
  cachedData.theGraph = theGraph;
  cachedData.chainlist = chainlist;
  cachedData.chains = chains;
  cachedData.slip44 = slip44;
  cachedData.indexed = indexData(theGraph, chainlist, chains, slip44);
  cachedData.lastUpdated = new Date().toISOString();
  
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
  if (!isNaN(query)) {
    const chainId = parseInt(query);
    const chain = getChainById(chainId);
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
 * Returns relations with composite keys: parentChainId-childChainId
 */
export function getAllRelations() {
  if (!cachedData.indexed) {
    return {};
  }
  
  const allRelations = {};
  
  // Allowed relation kinds
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
          
          // Create key using composite parentChainId-childChainId
          const key = `${parentChainId}-${childChainId}`;
          
          allRelations[key] = {
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
