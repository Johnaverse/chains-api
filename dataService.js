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
 * Index all data into a searchable structure
 */
function indexData(theGraph, chainlist, chains, slip44) {
  const indexed = {
    byChainId: {},
    byName: {},
    all: []
  };
  
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
            sources: ['chains']
          };
        }
        
        const nameLower = (chain.name || '').toLowerCase();
        if (!indexed.byName[nameLower]) {
          indexed.byName[nameLower] = [];
        }
        indexed.byName[nameLower].push(chainId);
      }
    });
  }
  
  // Merge chainlist RPC data
  if (chainlist) {
    Object.keys(chainlist).forEach(chainId => {
      const chainData = chainlist[chainId];
      if (!indexed.byChainId[chainId]) {
        indexed.byChainId[chainId] = {
          chainId: parseInt(chainId),
          name: chainData.name,
          rpc: chainData.rpc || [],
          sources: ['chainlist']
        };
      } else {
        // Merge RPC data
        if (chainData.rpc && Array.isArray(chainData.rpc)) {
          const existingRpcs = new Set(indexed.byChainId[chainId].rpc);
          chainData.rpc.forEach(rpc => {
            if (!existingRpcs.has(rpc)) {
              indexed.byChainId[chainId].rpc.push(rpc);
            }
          });
        }
        if (!indexed.byChainId[chainId].sources.includes('chainlist')) {
          indexed.byChainId[chainId].sources.push('chainlist');
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
      
      if (chainId !== null) {
        if (!indexed.byChainId[chainId]) {
          indexed.byChainId[chainId] = {
            chainId,
            name: network.fullName || network.shortName || network.id,
            shortName: network.shortName,
            nativeCurrency: { symbol: network.nativeToken },
            rpc: network.rpcUrls || [],
            explorers: network.explorerUrls || [],
            sources: ['theGraph']
          };
        } else {
          if (!indexed.byChainId[chainId].sources.includes('theGraph')) {
            indexed.byChainId[chainId].sources.push('theGraph');
          }
          // Merge RPC URLs
          if (network.rpcUrls && Array.isArray(network.rpcUrls)) {
            const existingRpcs = new Set(indexed.byChainId[chainId].rpc);
            network.rpcUrls.forEach(rpc => {
              if (!existingRpcs.has(rpc)) {
                indexed.byChainId[chainId].rpc.push(rpc);
              }
            });
          }
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
    if (cachedData.indexed.byChainId[chainId]) {
      results.push(cachedData.indexed.byChainId[chainId]);
    }
  }
  
  // Search by name (partial match)
  cachedData.indexed.all.forEach(chain => {
    if (chain.name && chain.name.toLowerCase().includes(queryLower)) {
      if (!results.find(r => r.chainId === chain.chainId)) {
        results.push(chain);
      }
    }
    if (chain.shortName && chain.shortName.toLowerCase().includes(queryLower)) {
      if (!results.find(r => r.chainId === chain.chainId)) {
        results.push(chain);
      }
    }
  });
  
  return results;
}

/**
 * Get chain by ID
 */
export function getChainById(chainId) {
  if (!cachedData.indexed) {
    return null;
  }
  
  return cachedData.indexed.byChainId[chainId] || null;
}

/**
 * Get all chains
 */
export function getAllChains() {
  if (!cachedData.indexed) {
    return [];
  }
  
  return cachedData.indexed.all;
}
