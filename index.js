import Fastify from 'fastify';
import { loadData, getCachedData, searchChains, getChainById, getAllChains } from './dataService.js';

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
  const chains = getAllChains();
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
      '/chains': 'Get all chains',
      '/chains/:id': 'Get chain by ID',
      '/search?q={query}': 'Search chains by name or ID',
      '/sources': 'Get data sources status',
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
