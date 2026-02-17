#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
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

// Create MCP server instance
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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Chains API MCP server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
