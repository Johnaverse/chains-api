#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import {
  loadData,
  getCachedData,
  searchChains,
  getChainById,
  getAllChains,
  getAllRelations,
  getRelationsById,
  getEndpointsById,
  getAllEndpoints,
  startRpcHealthCheck,
} from './dataService.js';

// Load data on startup
await loadData();
startRpcHealthCheck();

// Get configuration from environment
const MCP_PORT = Number.parseInt(process.env.MCP_PORT || '3001');
const MCP_HOST = process.env.MCP_HOST || '0.0.0.0';

// Create MCP server factory function
const createServer = () => {
  const server = new Server(
    {
      name: 'chains-api',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Define available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_chains',
          description: 'Get all blockchain chains, optionally filtered by tag (Testnet, L2, or Beacon)',
          inputSchema: {
            type: 'object',
            properties: {
              tag: {
                type: 'string',
                description: 'Optional tag to filter chains (e.g., "Testnet", "L2", "Beacon")',
                enum: ['Testnet', 'L2', 'Beacon'],
              },
            },
          },
        },
        {
          name: 'get_chain_by_id',
          description: 'Get detailed information about a specific blockchain chain by its chain ID',
          inputSchema: {
            type: 'object',
            properties: {
              chainId: {
                type: 'number',
                description: 'The chain ID to query (e.g., 1 for Ethereum mainnet, 137 for Polygon)',
              },
            },
            required: ['chainId'],
          },
        },
        {
          name: 'search_chains',
          description: 'Search for blockchain chains by name or other attributes',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query string (e.g., "ethereum", "polygon")',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_endpoints',
          description: 'Get RPC, firehose, and substreams endpoints for a specific chain or all chains',
          inputSchema: {
            type: 'object',
            properties: {
              chainId: {
                type: 'number',
                description: 'Optional chain ID. If provided, returns endpoints for that chain only. If omitted, returns all endpoints.',
              },
            },
          },
        },
        {
          name: 'get_relations',
          description: 'Get chain relationships (testnet/mainnet, L2/L1, etc.) for a specific chain or all chains',
          inputSchema: {
            type: 'object',
            properties: {
              chainId: {
                type: 'number',
                description: 'Optional chain ID. If provided, returns relations for that chain only. If omitted, returns all relations.',
              },
            },
          },
        },
        {
          name: 'get_slip44',
          description: 'Get SLIP-0044 coin type information by coin type ID or all coin types',
          inputSchema: {
            type: 'object',
            properties: {
              coinType: {
                type: 'number',
                description: 'Optional coin type ID (e.g., 0 for Bitcoin, 60 for Ethereum). If omitted, returns all coin types.',
              },
            },
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'get_chains': {
          let chains = getAllChains();

          // Filter by tag if provided
          if (args.tag) {
            chains = chains.filter(
              (chain) => chain.tags && chain.tags.includes(args.tag)
            );
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    count: chains.length,
                    chains,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_chain_by_id': {
          const chainId = args.chainId;

          if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'Invalid chain ID' }),
                },
              ],
              isError: true,
            };
          }

          const chain = getChainById(chainId);

          if (!chain) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'Chain not found' }),
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(chain, null, 2),
              },
            ],
          };
        }

        case 'search_chains': {
          const query = args.query;

          if (!query) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'Query is required' }),
                },
              ],
              isError: true,
            };
          }

          const results = searchChains(query);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    query,
                    count: results.length,
                    results,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case 'get_endpoints': {
          if (args.chainId !== undefined) {
            const chainId = args.chainId;

            if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'Invalid chain ID' }),
                  },
                ],
                isError: true,
              };
            }

            const result = getEndpointsById(chainId);

            if (!result) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'Chain not found' }),
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } else {
            const endpoints = getAllEndpoints();

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      count: endpoints.length,
                      endpoints,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        case 'get_relations': {
          if (args.chainId !== undefined) {
            const chainId = args.chainId;

            if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'Invalid chain ID' }),
                  },
                ],
                isError: true,
              };
            }

            const result = getRelationsById(chainId);

            if (!result) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'Chain not found' }),
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } else {
            const relations = getAllRelations();

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(relations, null, 2),
                },
              ],
            };
          }
        }

        case 'get_slip44': {
          const cachedData = getCachedData();

          if (!cachedData.slip44) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: 'SLIP-0044 data not loaded' }),
                },
              ],
              isError: true,
            };
          }

          if (args.coinType !== undefined) {
            const coinType = args.coinType;

            if (typeof coinType !== 'number' || Number.isNaN(coinType)) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'Invalid coin type' }),
                  },
                ],
                isError: true,
              };
            }

            const coinTypeData = cachedData.slip44[coinType];

            if (!coinTypeData) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ error: 'Coin type not found' }),
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(coinTypeData, null, 2),
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      count: Object.keys(cachedData.slip44).length,
                      coinTypes: cachedData.slip44,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Unknown tool: ${name}` }),
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Internal error',
              message: error.message,
            }),
          },
        ],
        isError: true,
      };
    }
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
    version: '1.0.0',
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
