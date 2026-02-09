# Chains API

A Node.js API query service built with Fastify that indexes and provides access to blockchain chain data from multiple sources. Also available as an MCP (Model Context Protocol) server for AI assistants.

## Features

- **Multi-Source Data Aggregation**: Combines data from multiple blockchain registries:
  - [The Graph Networks Registry](https://raw.githubusercontent.com/Johnaverse/networks-registry/refs/heads/main/public/TheGraphNetworksRegistry.json)
  - [Chainlist RPCs](https://chainlist.org/rpcs.json)
  - [Chain ID Network](https://chainid.network/chains.json) (for basic chain data and L2 relation indexing using parent field)
  - [SLIP-0044 Coin Types](https://github.com/satoshilabs/slips/blob/master/slip-0044.md)

- **Fast API**: Built with Fastify for high performance
- **MCP Server**: Available as a Model Context Protocol server for AI assistants
- **Indexed Data**: Efficient querying with indexed chain data
- **Search Capabilities**: Search chains by name, ID, or other attributes
- **RESTful Endpoints**: Clean and intuitive API design
- **Chain Relations & Tags**: Automatic indexing of chain relationships and tags
  - Tags: `Testnet`, `L2`, `Beacon`
  - Relations: `testnetOf`, `mainnetOf`, `l2Of`, `parentOf`, `beaconOf` with resolved chain IDs
  - Example: Base Sepolia (84532) is tagged as `Testnet` and `L2`, with relations to Base (8453) and Sepolia (11155111)
  - Reverse relations: Mainnets have `mainnetOf` relations pointing to testnets, L1s have `parentOf` relations pointing to L2s

## Installation

```bash
npm install
```

## Usage

### REST API Server

#### Start the server

```bash
npm start
```

The server will start on `http://localhost:3000` by default.

#### Development mode (with auto-reload)

```bash
npm run dev
```

### MCP Server (for AI Assistants)

The Chains API can also be used as an MCP (Model Context Protocol) server, allowing AI assistants like Claude to query blockchain chain data directly. Two transport modes are supported:

1. **Stdio Mode** (for local AI assistants like Claude Desktop)
2. **HTTP Mode** (for external clients like n8n, Make.com, etc.)

#### Running the MCP Server (Stdio Mode)

For local use with Claude Desktop and similar applications:

```bash
npm run mcp
```

Or directly with Node.js:

```bash
node mcp-server.js
```

#### Running the MCP HTTP Server (Network Mode)

For external clients that need HTTP access:

```bash
npm run mcp:http
```

Or directly with Node.js:

```bash
node mcp-server-http.js
```

The HTTP server will start on `http://0.0.0.0:3001` by default (configurable via `MCP_PORT` and `MCP_HOST` environment variables).

**Endpoints:**
- `POST /mcp` - MCP protocol endpoint for tool calls
- `DELETE /mcp` - Session termination endpoint
- `GET /health` - Health check
- `GET /` - Server information

**Example HTTP MCP usage with curl:**

```bash
# Initialize a session
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0.0"}}}'

# Extract session ID from the mcp-session-id header, then call a tool:
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <session-id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_chain_by_id","arguments":{"chainId":1}}}'
```

#### MCP Server Configuration (Stdio Mode)

To use the Chains API MCP server with Claude Desktop or other MCP clients, add it to your MCP settings configuration file:

**For Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):**

```json
{
  "mcpServers": {
    "chains-api": {
      "command": "node",
      "args": ["/path/to/chains-api/mcp-server.js"]
    }
  }
}
```

Or if you've installed the package globally:

```json
{
  "mcpServers": {
    "chains-api": {
      "command": "chains-api-mcp"
    }
  }
}
```

#### Available MCP Tools

The MCP server provides the following tools for querying blockchain chain data:

- **get_chains**: Get all blockchain chains, optionally filtered by tag (Testnet, L2, or Beacon)
- **get_chain_by_id**: Get detailed information about a specific blockchain chain by its chain ID
- **search_chains**: Search for blockchain chains by name or other attributes
- **get_endpoints**: Get RPC, firehose, and substreams endpoints for a specific chain or all chains
- **get_relations**: Get chain relationships (testnet/mainnet, L2/L1, etc.) for a specific chain or all chains
- **get_slip44**: Get SLIP-0044 coin type information by coin type ID or all coin types

Each tool returns JSON data that can be used by AI assistants to answer questions about blockchain networks.

## Environment Variables

- `PORT`: REST API server port (default: 3000)
- `HOST`: REST API server host (default: 0.0.0.0)
- `MCP_PORT`: MCP HTTP server port (default: 3001)
- `MCP_HOST`: MCP HTTP server host (default: 0.0.0.0)
- `GITHUB_TOKEN`: GitHub Personal Access Token for creating issues (required for `/validate/create-issues` endpoint, needs `repo` or `public_repo` scope)
- `GITHUB_OWNER`: GitHub repository owner (default: Johnaverse)
- `GITHUB_REPO`: GitHub repository name (default: chains-api)

## API Endpoints

### `GET /`
Get API information and available endpoints.

**Response:**
```json
{
  "name": "Chains API",
  "version": "1.0.0",
  "description": "API query service for blockchain chain data from multiple sources",
  "endpoints": { ... },
  "dataSources": [ ... ]
}
```

### `GET /health`
Health check and data status.

**Response:**
```json
{
  "status": "ok",
  "dataLoaded": true,
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "totalChains": 1234
}
```

### `GET /chains`
Get all indexed chains.

**Query Parameters:**
- `tag` (optional): Filter chains by tag (e.g., `Testnet`, `L2`, `Beacon`)

**Example:** `GET /chains?tag=Testnet`

**Response:**
```json
{
  "count": 1234,
  "chains": [ ... ]
}
```

**Example Chain Object:**
```json
{
  "chainId": 80002,
  "name": "Amoy",
  "shortName": "polygonamoy",
  "theGraph-id": "polygon-amoy",
  "fullName": "Polygon Amoy Testnet",
  "caip2Id": "eip155:80002",
  "aliases": ["amoy-testnet", "amoy"],
  "nativeCurrency": {
    "name": "POL",
    "symbol": "POL",
    "decimals": 18
  },
  "explorers": [ ... ],
  "infoURL": "https://polygon.technology/",
  "sources": ["chains", "theGraph"],
  "tags": ["Testnet", "L2"],
  "status": "active"
}
```

**Note:** Chain info no longer includes `rpc` or `relations` fields. Use `/endpoints/:id` for RPC endpoints and `/relations/:id` for chain relations.

### `GET /chains/:id`
Get a specific chain by its chain ID.

**Example:** `GET /chains/80002` (Amoy)

**Response:**
```json
{
  "chainId": 80002,
  "name": "Amoy",
  "shortName": "polygonamoy",
  "theGraph-id": "polygon-amoy",
  "fullName": "Polygon Amoy Testnet",
  "caip2Id": "eip155:80002",
  "aliases": ["amoy-testnet", "amoy"],
  "nativeCurrency": {
    "name": "POL",
    "symbol": "POL",
    "decimals": 18
  },
  "explorers": [
    {
      "name": "polygonscan-amoy",
      "url": "https://amoy.polygonscan.com",
      "standard": "EIP3091"
    }
  ],
  "infoURL": "https://polygon.technology/",
  "sources": ["chains", "theGraph"],
  "tags": ["Testnet", "L2"],
  "status": "active"
}
```

### `GET /search?q={query}`
Search chains by name or ID.

**Example:** `GET /search?q=ethereum`

**Response:**
```json
{
  "query": "ethereum",
  "count": 15,
  "results": [ ... ]
}
```

### `GET /endpoints`
Get endpoints (RPC, firehose, substreams) for all chains.

**Response:**
```json
{
  "count": 4236,
  "endpoints": [
    {
      "chainId": 80002,
      "name": "Amoy",
      "rpc": [
        "https://rpc-amoy.polygon.technology",
        "https://polygon-amoy-bor-rpc.publicnode.com",
        ...
      ],
      "firehose": [
        "amoy.firehose.pinax.network:443"
      ],
      "substreams": [
        "amoy.substreams.pinax.network:443"
      ]
    },
    ...
  ]
}
```

### `GET /endpoints/:id`
Get endpoints (RPC, firehose, substreams) for a specific chain by ID.

**Example:** `GET /endpoints/80002` (Amoy)

**Response:**
```json
{
  "chainId": 80002,
  "name": "Amoy",
  "rpc": [
    "https://rpc-amoy.polygon.technology",
    "https://polygon-amoy-bor-rpc.publicnode.com",
    "wss://polygon-amoy-bor-rpc.publicnode.com",
    "https://amoy.rpc.service.pinax.network"
  ],
  "firehose": [
    "amoy.firehose.pinax.network:443"
  ],
  "substreams": [
    "amoy.substreams.pinax.network:443"
  ]
}
```

### `GET /relations`
Get all chain relations data.

**Response:**
```json
{
  "count": 123,
  "relations": [ ... ]
}
```

### `GET /relations/:id`
Get relations for a specific chain by ID.

**Example:** `GET /relations/80002`

**Response:**
```json
{
  "chainId": 80002,
  "chainName": "Amoy",
  "relations": [
    {
      "kind": "testnetOf",
      "network": "matic",
      "chainId": 137,
      "source": "theGraph"
    },
    {
      "kind": "l2Of",
      "network": "sepolia",
      "chainId": 11155111,
      "source": "theGraph"
    }
  ]
}
```

### `GET /sources`
Get status of data sources.

**Response:**
```json
{
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "sources": {
    "theGraph": "loaded",
    "chainlist": "loaded",
    "chains": "loaded",
    "slip44": "loaded"
  }
}
```

### `GET /slip44`
Get all SLIP-0044 coin types as JSON. The table from the markdown file is converted to JSON format using "Coin type" as the key (id).

**Response:**
```json
{
  "count": 1279,
  "coinTypes": {
    "0": {
      "coinType": 0,
      "pathComponent": "0x80000000",
      "symbol": "BTC",
      "coin": "Bitcoin"
    },
    "60": {
      "coinType": 60,
      "pathComponent": "0x8000003c",
      "symbol": "ETH",
      "coin": "Ether"
    }
  }
}
```

### `GET /slip44/:coinType`
Get a specific SLIP-0044 coin type by its coin type ID.

**Example:** `GET /slip44/60` (Ethereum)

**Response:**
```json
{
  "coinType": 60,
  "pathComponent": "0x8000003c",
  "symbol": "ETH",
  "coin": "Ether"
}
```

### `POST /reload`
Reload data from all sources.

**Response:**
```json
{
  "status": "success",
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "totalChains": 1234
}
```

### `GET /validate`
Validate chain data for potential human errors across all three data sources.

This endpoint analyzes the chain data and identifies potential inconsistencies or errors based on the following rules:

1. **Rule 1 - Relation Conflicts**: Assumes graph relations are always true and finds conflicts with other sources
2. **Rule 2 - slip44/Testnet Mismatch**: Chains with slip44=1 but isTestnet=false
3. **Rule 3 - Name/Tag Mismatch**: Chain full names containing "Testnet" or "Devnet" but not tagged as Testnet
4. **Rule 4 - Sepolia/Hoodie Networks**: Chains containing "sepolia" or "hoodie" keywords but not identifying as L2 or having no relations
5. **Rule 5 - Status Conflicts**: Deprecated status conflicts across different sources
6. **Rule 6 - Goerli Deprecation**: Chains containing "Goerli" keyword but not marked as deprecated

**Response:**
```json
{
  "totalErrors": 85,
  "summary": {
    "rule1": 3,
    "rule2": 57,
    "rule3": 16,
    "rule4": 1,
    "rule5": 1,
    "rule6": 7
  },
  "errorsByRule": {
    "rule1_relation_conflicts": [...],
    "rule2_slip44_testnet_mismatch": [...],
    "rule3_name_testnet_mismatch": [...],
    "rule4_sepolia_hoodie_issues": [...],
    "rule5_status_conflicts": [...],
    "rule6_goerli_not_deprecated": [...]
  },
  "allErrors": [...]
}
```

**Example Error Object:**
```json
{
  "rule": 6,
  "chainId": 5,
  "chainName": "Goerli",
  "type": "goerli_not_deprecated",
  "message": "Chain 5 (Goerli) contains \"Goerli\" but is not marked as deprecated",
  "fullName": "Goerli",
  "status": "active",
  "statusInSources": []
}
```

### `POST /validate/create-issues`
Create GitHub issues for each relation conflict found in the validation results.

This endpoint creates a GitHub issue for each relation conflict (Rule 1) detected by the `/validate` endpoint. Each issue includes detailed information about the conflict, including the chain ID, name, the conflicting relation from The Graph, and the conflicting data from other sources.

**Prerequisites:**
- `GITHUB_TOKEN` environment variable must be set with a GitHub Personal Access Token that has `repo` or `public_repo` scope
- Optional: `GITHUB_OWNER` (default: "Johnaverse") and `GITHUB_REPO` (default: "chains-api")

**Response (Success):**
```json
{
  "message": "Successfully created 3 issues for relation conflicts",
  "totalConflicts": 3,
  "issuesCreated": 3,
  "issues": [
    {
      "chainId": 1287,
      "chainName": "Moonbase Alpha",
      "issueNumber": 123,
      "issueUrl": "https://github.com/Johnaverse/chains-api/issues/123"
    }
  ]
}
```

**Response (No Conflicts):**
```json
{
  "message": "No relation conflicts found",
  "issuesCreated": 0
}
```

**Response (Error - No Token):**
```json
{
  "error": "GITHUB_TOKEN environment variable is not set",
  "message": "Please set GITHUB_TOKEN to create issues"
}
```

**Created Issue Format:**

Each created issue will have:
- **Title:** `[Data Validation] Relation conflict for chain <chainId> (<chainName>)`
- **Labels:** `data-validation`, `relation-conflict`, `automated`
- **Body:** Detailed information about the conflict including:
  - Chain ID and name
  - Conflict type
  - The Graph relation details
  - Conflicting data from other sources

## Data Structure

### Chain Object (from `/chains` endpoints)

Each chain object returned from `/chains` and `/chains/:id` contains:

- `chainId`: The chain ID (extracted from caip2Id for The Graph data)
- `name`: Full name of the chain
- `shortName`: Short name/symbol
- `theGraph-id`: The Graph network identifier (if available from The Graph)
- `fullName`: Full network name (if available from The Graph)
- `caip2Id`: CAIP-2 identifier, e.g., "eip155:1" (if available from The Graph)
- `aliases`: Alternative names array (if available from The Graph)
- `nativeCurrency`: Native currency information
- `explorers`: Array of block explorers
- `infoURL`: Information URL
- `sources`: Array of data sources that provided this chain's data
- `status`: Chain status - defaults to `"active"` when not present in any data source
- `tags`: Array of tags (e.g., "Testnet", "L2", "Beacon")

**Note:** Chain objects no longer include `rpc` or `relations` fields. Use `/endpoints/:id` for RPC endpoints and `/relations/:id` for relations.

### Endpoints Object (from `/endpoints` endpoints)

Each endpoints object returned from `/endpoints` and `/endpoints/:id` contains:

- `chainId`: The chain ID
- `name`: Chain name
- `rpc`: Array of RPC endpoints (strings or objects with url and metadata)
- `firehose`: Array of The Graph firehose endpoints (if available)
- `substreams`: Array of The Graph substreams endpoints (if available)

### Relations Object (from `/relations/:id` endpoint)

Relations data contains:
- `chainId`: The chain ID
- `chainName`: Chain name
- `relations`: Array of relations to other chains
  - Each relation contains: `kind`, `network` (network ID), optionally `chainId` (resolved chain ID), and `source` (data source)
  - Relation kinds: `testnetOf`, `mainnetOf`, `l2Of`, `parentOf`, `beaconOf`
  - Relation sources: `theGraph`, `chainlist`, `chains`
  - **Reverse relations**: After all relations are indexed, reverse relations are automatically created:
    - `mainnetOf`: Added to mainnets pointing to their testnets (reverse of `testnetOf`)
    - `parentOf`: Added to L1 chains pointing to their L2 chains (reverse of `l2Of`)
  - **chainlist relations**: When `slip44 === 1` or `isTestnet === true`, finds mainnet by matching `tvl` field value with chains where `isTestnet === false`
    - Note: `tvl` matching is based on chainlist data structure; this field may represent a chain identifier rather than Total Value Locked in some contexts
  - **chains.json relations**: When `parent.type === "L2"`, creates `l2Of` relation using parent chain ID extracted from `parent.chain` field (format: `eip155-<chainId>`)
    - Example: Mode Testnet (919) has `parent: { type: "L2", chain: "eip155-11155111" }`, creating a `l2Of` relation to Sepolia (11155111)

## SLIP-0044 Data Structure

Each SLIP-0044 coin type object contains:

- `coinType`: The coin type number (used as the key/id)
- `pathComponent`: BIP-0044 path component in hexadecimal
- `symbol`: Coin symbol
- `coin`: Full coin name

## License

ISC