import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { loadData, getCachedData, searchChains, getChainById, getAllChains, getAllRelations, getRelationsById, getEndpointsById, getAllEndpoints } from './dataService.js';
import { getMonitoringResults, getMonitoringStatus, startRpcHealthCheck } from './rpcMonitor.js';
import {
  PORT, HOST, BODY_LIMIT, MAX_PARAM_LENGTH,
  RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS,
  RELOAD_RATE_LIMIT_MAX, SEARCH_RATE_LIMIT_MAX,
  MAX_SEARCH_QUERY_LENGTH, CORS_ORIGIN,
  DATA_SOURCE_THE_GRAPH, DATA_SOURCE_CHAINLIST,
  DATA_SOURCE_CHAINS, DATA_SOURCE_SLIP44
} from './config.js';

const fastify = Fastify({
  logger: true,
  bodyLimit: BODY_LIMIT,
  maxParamLength: MAX_PARAM_LENGTH
});

// Security: CORS
await fastify.register(cors, {
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map(s => s.trim()),
  credentials: false
});

// Security: Helmet (security headers)
await fastify.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"]
    }
  }
});

// Security: Rate limiting
await fastify.register(rateLimit, {
  max: RATE_LIMIT_MAX,
  timeWindow: RATE_LIMIT_WINDOW_MS
});

// Load data on startup
await loadData();
startRpcHealthCheck();

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

  // Filter by tag if provided (validate against known tags)
  if (tag) {
    const validTags = ['Testnet', 'L2', 'Beacon'];
    if (!validTags.includes(tag)) {
      return reply.code(400).send({ error: `Invalid tag. Allowed: ${validTags.join(', ')}` });
    }
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
  const chainId = Number.parseInt(request.params.id, 10);

  if (Number.isNaN(chainId)) {
    return reply.code(400).send({ error: 'Invalid chain ID' });
  }

  const chain = getChainById(chainId);

  if (!chain) {
    return reply.code(404).send({ error: 'Chain not found' });
  }

  return chain;
});

/**
 * Search chains (tighter rate limit)
 */
fastify.get('/search', {
  config: {
    rateLimit: {
      max: SEARCH_RATE_LIMIT_MAX,
      timeWindow: RATE_LIMIT_WINDOW_MS
    }
  }
}, async (request, reply) => {
  const { q } = request.query;

  if (!q) {
    return reply.code(400).send({ error: 'Query parameter "q" is required' });
  }

  if (q.length > MAX_SEARCH_QUERY_LENGTH) {
    return reply.code(400).send({ error: `Query too long. Max length: ${MAX_SEARCH_QUERY_LENGTH}` });
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
  const chainId = Number.parseInt(request.params.id, 10);

  if (Number.isNaN(chainId)) {
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
  const chainId = Number.parseInt(request.params.id, 10);

  if (Number.isNaN(chainId)) {
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
  const coinType = Number.parseInt(request.params.coinType, 10);

  if (Number.isNaN(coinType)) {
    return reply.code(400).send({ error: 'Invalid coin type' });
  }

  const cachedData = getCachedData();

  if (!cachedData.slip44 || !cachedData.slip44[coinType]) {
    return reply.code(404).send({ error: 'Coin type not found' });
  }

  return cachedData.slip44[coinType];
});

/**
 * Reload data from sources (tighter rate limit)
 */
fastify.post('/reload', {
  config: {
    rateLimit: {
      max: RELOAD_RATE_LIMIT_MAX,
      timeWindow: RATE_LIMIT_WINDOW_MS
    }
  }
}, async (request, reply) => {
  try {
    await loadData();
    startRpcHealthCheck();
    const cachedData = getCachedData();
    return {
      status: 'success',
      lastUpdated: cachedData.lastUpdated,
      totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0
    };
  } catch (error) {
    fastify.log.error(error, 'Failed to reload data');
    return reply.code(500).send({ error: 'Failed to reload data' });
  }
});

/**
 * Get RPC monitoring results
 */
fastify.get('/rpc-monitor', async (request, reply) => {
  const results = getMonitoringResults();
  const status = getMonitoringStatus();

  return {
    ...status,
    ...results
  };
});

/**
 * Get RPC monitoring results for a specific chain
 */
fastify.get('/rpc-monitor/:id', async (request, reply) => {
  const chainId = Number.parseInt(request.params.id, 10);

  if (Number.isNaN(chainId)) {
    return reply.code(400).send({ error: 'Invalid chain ID' });
  }

  const results = getMonitoringResults();
  const chainResults = results.results.filter(r => r.chainId === chainId);

  if (chainResults.length === 0) {
    return reply.code(404).send({ error: 'No monitoring results found for this chain' });
  }

  const workingCount = chainResults.filter(r => r.status === 'working').length;

  return {
    chainId,
    chainName: chainResults[0].chainName,
    totalEndpoints: chainResults.length,
    workingEndpoints: workingCount,
    lastUpdated: results.lastUpdated,
    endpoints: chainResults
  };
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
      '/reload': 'Reload data from sources (POST)',
      '/rpc-monitor': 'Get RPC endpoint monitoring results',
      '/rpc-monitor/:id': 'Get RPC monitoring results for a specific chain by ID'
    },
    dataSources: [
      DATA_SOURCE_THE_GRAPH,
      DATA_SOURCE_CHAINLIST,
      DATA_SOURCE_CHAINS,
      DATA_SOURCE_SLIP44
    ]
  };
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Server is running at http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
