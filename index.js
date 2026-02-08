import Fastify from 'fastify';
import { loadData, getCachedData, searchChains, getChainById, getAllChains, getAllRelations, getRelationsById, getEndpointsById, getAllEndpoints } from './dataService.js';

const fastify = Fastify({
  logger: true
});

// Load data on startup
await loadData();

/**
 * Health check endpoint
 */
fastify.get('/health', async (request, reply) => {
  const cachedData = getCachedData();
  return {
    status: 'ok',
    dataLoaded: cachedData.indexed !== null,
    lastUpdated: cachedData.lastUpdated,
    totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
  };
});

/**
 * Get all chains
 */
fastify.get('/chains', async (request, reply) => {
  const { tag } = request.query;
  let chains = getAllChains();
  
  // Filter by tag if provided
  if (tag) {
    chains = chains.filter(chain => chain.tags && chain.tags.includes(tag));
  }
  
  return {
    count: chains.length,
    chains
  };
});

/**
 * Get chain by ID
 */
fastify.get('/chains/:id', async (request, reply) => {
  const chainId = parseInt(request.params.id);
  
  if (isNaN(chainId)) {
    return reply.code(400).send({ error: 'Invalid chain ID' });
  }
  
  const chain = getChainById(chainId);
  
  if (!chain) {
    return reply.code(404).send({ error: 'Chain not found' });
  }
  
  return chain;
});

/**
 * Search chains
 */
fastify.get('/search', async (request, reply) => {
  const { q } = request.query;
  
  if (!q) {
    return reply.code(400).send({ error: 'Query parameter "q" is required' });
  }
  
  const results = searchChains(q);
  
  return {
    query: q,
    count: results.length,
    results
  };
});

/**
 * Get all chain relations
 */
fastify.get('/relations', async (request, reply) => {
  const relations = getAllRelations();
  
  return relations;
});

/**
 * Get relations for a specific chain by ID
 */
fastify.get('/relations/:id', async (request, reply) => {
  const chainId = parseInt(request.params.id);
  
  if (isNaN(chainId)) {
    return reply.code(400).send({ error: 'Invalid chain ID' });
  }
  
  const result = getRelationsById(chainId);
  
  if (!result) {
    return reply.code(404).send({ error: 'Chain not found' });
  }
  
  return result;
});

/**
 * Get all endpoints
 */
fastify.get('/endpoints', async (request, reply) => {
  const endpoints = getAllEndpoints();
  
  return {
    count: endpoints.length,
    endpoints
  };
});

/**
 * Get endpoints for a specific chain by ID
 */
fastify.get('/endpoints/:id', async (request, reply) => {
  const chainId = parseInt(request.params.id);
  
  if (isNaN(chainId)) {
    return reply.code(400).send({ error: 'Invalid chain ID' });
  }
  
  const result = getEndpointsById(chainId);
  
  if (!result) {
    return reply.code(404).send({ error: 'Chain not found' });
  }
  
  return result;
});

/**
 * Get raw data sources
 */
fastify.get('/sources', async (request, reply) => {
  const cachedData = getCachedData();
  return {
    lastUpdated: cachedData.lastUpdated,
    sources: {
      theGraph: cachedData.theGraph ? 'loaded' : 'not loaded',
      chainlist: cachedData.chainlist ? 'loaded' : 'not loaded',
      chains: cachedData.chains ? 'loaded' : 'not loaded',
      slip44: cachedData.slip44 ? 'loaded' : 'not loaded'
    }
  };
});

/**
 * Get SLIP-0044 coin types as JSON
 */
fastify.get('/slip44', async (request, reply) => {
  const cachedData = getCachedData();
  
  if (!cachedData.slip44) {
    return reply.code(503).send({ error: 'SLIP-0044 data not loaded' });
  }
  
  return {
    count: Object.keys(cachedData.slip44).length,
    coinTypes: cachedData.slip44
  };
});

/**
 * Get specific SLIP-0044 coin type by ID
 */
fastify.get('/slip44/:coinType', async (request, reply) => {
  const coinType = parseInt(request.params.coinType);
  
  if (isNaN(coinType)) {
    return reply.code(400).send({ error: 'Invalid coin type' });
  }
  
  const cachedData = getCachedData();
  
  if (!cachedData.slip44 || !cachedData.slip44[coinType]) {
    return reply.code(404).send({ error: 'Coin type not found' });
  }
  
  return cachedData.slip44[coinType];
});

/**
 * Reload data from sources
 */
fastify.post('/reload', async (request, reply) => {
  try {
    await loadData();
    const cachedData = getCachedData();
    return {
      status: 'success',
      lastUpdated: cachedData.lastUpdated,
      totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
    };
  } catch (error) {
    return reply.code(500).send({ error: 'Failed to reload data', message: error.message });
  }
});

/**
 * Root endpoint with API information
 */
fastify.get('/', async (request, reply) => {
  return {
    name: 'Chains API',
    version: '1.0.0',
    description: 'API query service for blockchain chain data from multiple sources',
    endpoints: {
      '/health': 'Health check and data status',
      '/chains': 'Get all chains (optional ?tag=Testnet|L2|Beacon)',
      '/chains/:id': 'Get chain by ID',
      '/search?q={query}': 'Search chains by name or ID',
      '/relations': 'Get all chain relations data',
      '/relations/:id': 'Get relations for a specific chain by ID',
      '/endpoints': 'Get all chain endpoints (RPC, firehose, substreams)',
      '/endpoints/:id': 'Get endpoints for a specific chain by ID',
      '/sources': 'Get data sources status',
      '/slip44': 'Get all SLIP-0044 coin types as JSON',
      '/slip44/:coinType': 'Get specific SLIP-0044 coin type by ID',
      '/reload': 'Reload data from sources (POST)'
    },
    dataSources: [
      'https://raw.githubusercontent.com/Johnaverse/networks-registry/refs/heads/main/public/TheGraphNetworksRegistry.json',
      'https://chainlist.org/rpcs.json',
      'https://chainid.network/chains.json',
      'https://github.com/satoshilabs/slips/blob/master/slip-0044.md'
    ]
  };
});

// Start server
const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    const host = process.env.HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    console.log(`Server is running at http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
