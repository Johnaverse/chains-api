#!/usr/bin/env node

/**
 * Combined entry point: serves the REST API (Fastify, PORT) and the MCP HTTP
 * server (Express, MCP_PORT) from a SINGLE process.
 *
 * Why one process: both surfaces read from the same in-memory store
 * (src/store/), which is a module-level singleton. Running them as separate
 * containers means each process loads the data and runs its own refreshers —
 * the same public RPC endpoints get pinged twice, L2BEAT/sources fetched
 * twice, etc. Here the REST side (buildApp) owns the single load + refresh
 * loop, and the MCP listener attaches to the already-populated shared store
 * (loadData: false), so nothing is refreshed more than once.
 */

import { buildApp } from './src/http/app.js';
import { startMcpHttpServer } from './mcp-server-http.js';
import { PORT, HOST } from './config.js';
import { logger } from './src/util/logger.js';
import { closeRpcHealthDb } from './src/store/rpcHealthDb.js';
import { startTracing } from './src/util/startTracing.js';
import { stopChainRefresher } from './src/services/chainRefresher.js';

const start = async () => {
  // Before anything is built: the first load and every request after it are traced.
  const tracing = await startTracing();
  // buildApp() loads data and starts the refreshers (RPC health, L2BEAT,
  // source self-heal) exactly once for the whole process.
  const app = await buildApp();
  await app.listen({ port: PORT, host: HOST });
  logger.info(`REST API listening at http://${HOST}:${PORT}`);

  // MCP HTTP reuses the shared, already-loaded store — no second refresh.
  const { app: mcpApp } = await startMcpHttpServer({ loadData: false });
  const transports = mcpApp.locals.transports;

  const shutdown = async () => {
    logger.info('Shutting down combined server');
    for (const sessionId in transports) {
      try {
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        logger.error({ sessionId, err: error.message || error }, 'Error closing MCP transport');
      }
    }
    try {
      await app.close();
    } catch (error) {
      logger.error({ err: error.message || error }, 'Error closing REST server');
    }
    await closeRpcHealthDb();
    // Ends the sweep in progress (as not completed) so its span is sent with the rest.
    stopChainRefresher();
    await tracing.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start().catch((err) => {
  logger.error({ err: err.message || err }, 'Failed to start combined server');
  process.exit(1);
});
