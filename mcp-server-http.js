#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createRequire } from 'node:module';
import { initializeDataOnStartup, getCachedData } from './dataService.js';
import { startRpcHealthCheck } from './rpcMonitor.js';
import { getToolDefinitions, handleToolCall } from './mcp-tools.js';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

// Load data on startup
await initializeDataOnStartup({
  onBackgroundRefreshSuccess: () => {
    startRpcHealthCheck();
  }
});
startRpcHealthCheck();

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

// Create Express app
const app = express();

// Avoid implicit framework/version disclosure
app.disable('x-powered-by');

// Parse JSON bodies
app.use(express.json({ limit: '4mb' }));

// Map to store transports by session ID
const transports = {};

// MCP POST endpoint
const mcpPostHandler = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId) {
    console.log(`Received MCP request for session: ${sessionId}`);
  }

  try {
    let transport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        },
      });

      // Set up onclose handler
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ${sid}`);
          delete transports[sid];
        }
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
    console.error('Error handling MCP request:', error);
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

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
};

// Set up routes
app.post('/mcp', mcpPostHandler);
app.delete('/mcp', mcpDeleteHandler);

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

// Start server
const server = app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(`Chains API MCP HTTP Server listening on http://${MCP_HOST}:${MCP_PORT}`);
  console.log(`MCP endpoint: http://${MCP_HOST}:${MCP_PORT}/mcp`);
  console.log(`Health check: http://${MCP_HOST}:${MCP_PORT}/health`);
});

// Handle server startup errors
server.on('error', (error) => {
  console.error('Failed to start MCP HTTP server:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down MCP HTTP server...');

  // Close all active transports
  for (const sessionId in transports) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }

  console.log('Server shutdown complete');
  process.exit(0);
});
