#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createRequire } from 'node:module';
import { initializeDataOnStartup, getCachedData, startRpcHealthCheck } from './dataService.js';
import { getToolDefinitions, handleToolCall } from './mcp-tools.js';
import { logger } from './src/util/logger.js';
import { clientKey } from './src/http/clientKey.js';
import { RATE_LIMIT_WINDOW_MS, MCP_RATE_LIMIT_MAX, MCP_MAX_SESSIONS, MCP_SESSION_IDLE_MS } from './config.js';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

// Get configuration from environment
const MCP_PORT = Number.parseInt(process.env.MCP_PORT || '3001');
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0';

// Create MCP server factory function
const createServer = () => {
  const server = new Server(
    {
      name: 'chains-api',
      version,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions(),
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(name, args);
  });

  return server;
};

/**
 * Build the Express app that serves the MCP HTTP transport plus /health and /.
 * Does NOT load data or start refreshers — the caller owns the shared data
 * source. When this module runs as the combined server's MCP listener, the
 * REST process has already loaded data into the shared in-memory store.
 */
export function createMcpHttpApp({ now = Date.now } = {}) {
  const app = express();

  // Avoid implicit framework/version disclosure
  app.disable('x-powered-by');

  // Parse JSON bodies
  app.use(express.json({ limit: '4mb' }));

  // Map to store transports by session ID
  const transports = {};
  // When each session was last used. Sessions used to live until the client closed them, so
  // clients that never did grew the map without bound.
  const lastSeen = new Map();
  const sessionCount = () => Object.keys(transports).length;

  // Per-client request budget for /mcp, keyed like the REST limits (clientKey.js). A tool call
  // can make chains-api reach out — an on-demand RPC probe (get_rpc_monitor_by_id, with its
  // eth_config read), block explorers (check_chain_halt) — so an unthrottled client could
  // drive thousands of outbound requests.
  const budgets = new Map(); // key -> { count, resetAt }
  const limitMcp = (req, res, next) => {
    const key = clientKey(req.headers, req.socket?.remoteAddress);
    const t = now();
    let b = budgets.get(key);
    if (!b || t >= b.resetAt) {
      b = { count: 0, resetAt: t + RATE_LIMIT_WINDOW_MS };
      budgets.set(key, b);
    }
    b.count += 1;
    if (b.count <= MCP_RATE_LIMIT_MAX) return next();
    res.set('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - t) / 1000))));
    res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests' }, id: null });
  };

  /** Close sessions unused for MCP_SESSION_IDLE_MS, and forget spent rate budgets. */
  const sweep = async () => {
    const t = now();
    for (const [sessionId, seen] of lastSeen) {
      if (t - seen < MCP_SESSION_IDLE_MS) continue;
      const transport = transports[sessionId];
      lastSeen.delete(sessionId);
      delete transports[sessionId];
      if (transport) {
        logger.info({ sessionId }, 'Closing idle MCP session');
        await transport.close().catch(() => {});
      }
    }
    for (const [key, b] of budgets) if (t >= b.resetAt) budgets.delete(key);
  };
  const sweeper = setInterval(() => { sweep().catch(() => {}); }, Math.min(MCP_SESSION_IDLE_MS, 60000));
  sweeper.unref?.();

  // MCP POST endpoint
  const mcpPostHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId) {
      logger.info({ sessionId }, 'Received MCP request');
    }

    try {
      let transport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
        lastSeen.set(sessionId, now());
      } else if (!sessionId && isInitializeRequest(req.body)) {
        if (sessionCount() >= MCP_MAX_SESSIONS) await sweep();
        if (sessionCount() >= MCP_MAX_SESSIONS) {
          res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions; try again later' }, id: null });
          return;
        }
        // New initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sessionId) => {
            logger.info({ sessionId }, 'MCP session initialized');
            transports[sessionId] = transport;
            lastSeen.set(sessionId, now());
          },
        });

        // Set up onclose handler
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info({ sessionId: sid }, 'MCP transport closed');
            delete transports[sid];
          }
          if (sid) lastSeen.delete(sid);
        };

        // Connect the transport to the MCP server
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        // Invalid request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle request with existing transport
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error.message || error }, 'Error handling MCP request');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  };

  // DELETE endpoint for session termination
  const mcpDeleteHandler = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    logger.info({ sessionId }, 'Received MCP session termination request');

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error({ err: error.message || error }, 'Error handling MCP session termination');
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  };

  // Set up routes
  app.post('/mcp', limitMcp, mcpPostHandler);
  app.delete('/mcp', limitMcp, mcpDeleteHandler);

  // Health check endpoint
  app.get('/health', (req, res) => {
    const cachedData = getCachedData();
    res.json({
      status: 'ok',
      service: 'chains-api-mcp-http',
      dataLoaded: cachedData.indexed !== null,
      lastUpdated: cachedData.lastUpdated,
      totalChains: cachedData.indexed ? cachedData.indexed.all.length : 0,
      activeSessions: Object.keys(transports).length,
    });
  });

  // Info endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'Chains API - MCP HTTP Server',
      version,
      description: 'HTTP-based MCP server for blockchain chain data',
      endpoints: {
        '/mcp': 'MCP protocol endpoint (POST for requests, DELETE for session termination)',
        '/health': 'Health check',
      },
      mcpEndpoint: `http://${MCP_HOST}:${MCP_PORT}/mcp`,
      documentation: 'https://github.com/Johnaverse/chains-api',
    });
  });

  // Expose the transport registry so callers can close sessions on shutdown.
  app.locals.transports = transports;
  app.locals.sweepIdleSessions = sweep;
  app.locals.stopSweeper = () => clearInterval(sweeper);
  return app;
}

/**
 * Start the MCP HTTP listener.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.loadData=true] When true, load data and start the RPC
 *   health check before listening. The combined server (server.js) passes
 *   false because the REST process has already loaded the shared data source —
 *   this is what keeps a single container from refreshing the same public
 *   endpoints twice.
 * @returns {Promise<{server: import('node:http').Server, app: import('express').Express}>}
 */
export async function startMcpHttpServer({ loadData = true } = {}) {
  if (loadData) {
    await initializeDataOnStartup({
      onBackgroundRefreshSuccess: () => {
        startRpcHealthCheck();
      },
    });
    startRpcHealthCheck();
  }

  const app = createMcpHttpApp();

  return await new Promise((resolve, reject) => {
    const server = app.listen(MCP_PORT, MCP_HOST, () => {
      logger.info(
        {
          url: `http://${MCP_HOST}:${MCP_PORT}`,
          mcpEndpoint: `http://${MCP_HOST}:${MCP_PORT}/mcp`,
          healthEndpoint: `http://${MCP_HOST}:${MCP_PORT}/health`,
        },
        'Chains API MCP HTTP Server listening'
      );
      resolve({ server, app });
    });

    server.on('error', (error) => {
      logger.error({ err: error.message || error }, 'Failed to start MCP HTTP server');
      reject(error);
    });
  });
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const { app } = await startMcpHttpServer({ loadData: true });
  const transports = app.locals.transports;

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down MCP HTTP server');

    for (const sessionId in transports) {
      try {
        logger.info({ sessionId }, 'Closing MCP transport');
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        logger.error({ sessionId, err: error.message || error }, 'Error closing MCP transport');
      }
    }

    logger.info('MCP server shutdown complete');
    process.exit(0);
  });
}
