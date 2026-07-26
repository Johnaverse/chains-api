# Chains API

A Node.js API query service built with Fastify that indexes and provides access to blockchain chain data from multiple sources. Also available as an MCP (Model Context Protocol) server for AI assistants.

[![Quality Gate Status](https://sonarqube.johnaverse.cc/api/project_badges/measure?project=Johnaverse_chains-api_b1d9cb46-69c9-4113-87b4-a683c3719545&metric=alert_status&token=sqb_f811cddeb6638fae0a93734928f5b566e268f558)](https://sonarqube.johnaverse.cc/dashboard?id=Johnaverse_chains-api_b1d9cb46-69c9-4113-87b4-a683c3719545)

## Code Quality & Testing

This project maintains high code quality standards through:

- **Comprehensive Testing**: Includes unit tests, integration tests, and fuzz testing
  - 300+ test cases covering all core functionality
  - Continuous integration with automated test runs on every push
  - See [Testing Documentation](docs/TESTING.md) for details

- **SonarQube Analysis**: Automated code quality scanning on every commit
  - Enforces code coverage requirements (≥80%)
  - Monitors code duplication (≤3%)
  - Tracks cognitive complexity and code smells

All changes are validated through GitHub Actions CI/CD pipeline, ensuring code quality and test coverage before deployment.

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

- **RPC Health Monitoring**: Automatic background monitoring of RPC endpoints to identify working and failed nodes.
- **Data Validation**: Built-in validation tools to identify data inconsistencies between multiple sources (e.g., The Graph registry vs. Chainlist).

## Installation

### Using npm

```bash
npm install
```

### Using Docker

#### Pull from GitHub Container Registry

Pre-built Docker images are automatically published to GitHub Container Registry (GHCR) on every push to the main branch:

```bash
# Pull the latest image
docker pull ghcr.io/johnaverse/chains-api:latest

# Or pull a specific version
docker pull ghcr.io/johnaverse/chains-api:v1.1.1
```

#### Build Docker image locally

```bash
# Build the image
docker build -t chains-api .

# Or using docker compose
docker compose build
```

## Usage

### Running with Docker

#### Run the REST API server

```bash
# Using pre-built image from GHCR
docker run -d -p 3000:3000 --name chains-api ghcr.io/johnaverse/chains-api:latest

# Or using locally built image
docker run -d -p 3000:3000 --name chains-api chains-api

# With custom environment variables
docker run -d -p 3000:3000 \
  -e PORT=3000 \
  -e HOST=0.0.0.0 \
  --name chains-api \
  ghcr.io/johnaverse/chains-api:latest
```

The API will be available at `http://localhost:3000`.

#### Run the MCP HTTP server

```bash
docker run -d -p 3001:3001 \
  --name chains-api-mcp \
  ghcr.io/johnaverse/chains-api:latest \
  node mcp-server-http.js
```

The MCP HTTP server will be available at `http://localhost:3001`.

#### Using Docker Compose

A `docker-compose.yml` file is included in the repository that runs both the REST API server on port 3000 and the MCP HTTP server on port 3001:

```bash
docker compose up -d
```

To use pre-built images from GHCR instead of building locally, modify the `docker-compose.yml` to use `image: ghcr.io/johnaverse/chains-api:latest` instead of `build: .`

The default configuration:

```yaml
services:
  chains-api:
    build: .
    image: chains-api:latest
    container_name: chains-api
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - HOST=0.0.0.0
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })",
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 5s

  chains-api-mcp:
    build: .
    image: chains-api:latest
    container_name: chains-api-mcp
    command: node mcp-server-http.js
    ports:
      - "3001:3001"
    environment:
      - MCP_PORT=3001
      - MCP_HOST=0.0.0.0
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "require('http').get('http://localhost:3001/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })",
        ]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 5s
```

### Running with npm

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

#### Using a Proxy (Optional)

To route all outbound requests through a proxy server, set the `PROXY_URL` environment variable:

```bash
# Using a proxy without authentication
PROXY_URL=http://proxy.example.com:8080 npm start

# Using a proxy with authentication
PROXY_URL=http://user:pass@proxy.example.com:8080 npm start
```

When configured, the proxy will be used for:
- All RPC endpoint health checks and monitoring
- Fetching data from external sources (The Graph, Chainlist, etc.)

The proxy configuration is optional and disabled by default. See the [Environment Variables](#environment-variables) section for more details.

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
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"my-client","version":"1.1.1"}}}'

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

### Server Configuration
- `PORT`: REST API server port (default: 3000)
- `HOST`: REST API server host (default: 0.0.0.0)
- `MCP_PORT`: MCP HTTP server port (default: 3001)
- `MCP_HOST`: MCP HTTP server host (default: 0.0.0.0)

### Proxy Configuration (Optional)
- `PROXY_URL`: HTTP/HTTPS proxy URL for all outbound requests (default: empty/disabled)
  - Example: `http://proxy.example.com:8080`
  - With authentication: `http://user:pass@proxy.example.com:8080`
  - When set, all RPC requests and data source fetching will route through this proxy
  - Leave empty or unset to disable proxy support

### Rate Limiting
- `RATE_LIMIT_MAX`: Maximum requests per window for global endpoints (default: 100)
- `RATE_LIMIT_WINDOW_MS`: Rate limit window in milliseconds (default: 60000 = 1 minute)
- `RELOAD_RATE_LIMIT_MAX`: Maximum `/reload` requests per window (default: 5)
- `SEARCH_RATE_LIMIT_MAX`: Maximum `/search` requests per window (default: 30)

### RPC Health Check
- `RPC_CHECK_TIMEOUT_MS`: Timeout per RPC health check call in milliseconds (default: 8000)
- `RPC_CHECK_CONCURRENCY`: Number of parallel RPC health checks (default: 8)
- `MAX_ENDPOINTS_PER_CHAIN`: Maximum RPC endpoints tested per chain (default: 5)

### Data Cache
- `DATA_CACHE_ENABLED`: Enable disk-backed startup cache (default: `true`)
- `DATA_CACHE_FILE`: Snapshot file path used for stale-first startup (default: `.cache/chains-api-data.json`)

### Assistant (Optional)
An LLM chat assistant over the whole registry plus live incidents, exposed at `POST /assistant/chat` and consumed by the dashboard's floating **chat overlay** (corner button, available on every view). It runs a tool-use loop against any OpenAI-compatible server (Ollama, vLLM, LM Studio) and stays disabled until configured:

```bash
ollama pull qwen3
ASSISTANT_LLM_URL=http://localhost:11434 npm start
```

- `ASSISTANT_LLM_URL`: OpenAI-compatible LLM base URL (default: empty = assistant disabled)
- `ASSISTANT_LLM_API_KEY`: Bearer token for key-protected servers such as OpenAI or OpenRouter (default: empty — not needed for a plain Ollama)
- `ASSISTANT_MODEL`: Model name passed to `/v1/chat/completions` (default: `qwen3`)
- `ASSISTANT_MAX_TOOL_ITERATIONS`: Hard cap on LLM round-trips per request (default: 6)
- `ASSISTANT_TIMEOUT_MS`: Overall per-request deadline (default: 60000)
- `ASSISTANT_MAX_TOKENS`: `max_tokens` per LLM call (default: 1024)
- `ASSISTANT_RATE_LIMIT_MAX`: Maximum `/assistant/chat` requests per window per IP (default: 10)
- `ASSISTANT_TOPIC_GUARD`: Pre-classify each question with a cheap extra LLM call and refuse off-topic ones before the tool loop runs; fails open if the classifier misbehaves (default: `true`)
- `ASSISTANT_FALLBACK_LLM_URL` / `ASSISTANT_FALLBACK_MODEL` / `ASSISTANT_FALLBACK_LLM_API_KEY`: Optional backup provider — see below.

#### Fallback provider (optional)

Configure a second OpenAI-compatible server and the assistant survives the primary going down:

```bash
# Example 1: big model with a smaller local backup on another port
ASSISTANT_LLM_URL=http://10.0.0.47:8000        ASSISTANT_MODEL=qwen3-27b \
ASSISTANT_FALLBACK_LLM_URL=http://localhost:11434 ASSISTANT_FALLBACK_MODEL=qwen3:8b \
npm start

# Example 2: local primary with a hosted API as the backup
ASSISTANT_LLM_URL=http://localhost:11434       ASSISTANT_MODEL=qwen3 \
ASSISTANT_FALLBACK_LLM_URL=https://openrouter.ai/api ASSISTANT_FALLBACK_MODEL=qwen/qwen3-32b \
ASSISTANT_FALLBACK_LLM_API_KEY=sk-or-... \
npm start
```

Behavior:
- A chat run starts on the primary; if any LLM call fails (connection refused, timeout, HTTP error), the run switches to the backup and **stays on it for the rest of that run**. The next chat tries the primary again — no manual reset needed after recovery.
- The switch is visible: the thinking trace shows a *"switching to backup model"* step, the answer JSON carries `viaFallback: true`, and the dashboard bubble gets a **backup model** badge.
- While an untried backup remains, a single primary attempt is capped at 60s so an unresponsive primary can't consume the whole request budget before failover.
- `GET /assistant` reports `reachable: true` if **either** provider answers, so the dashboard pill stays green during a primary outage.
- The backup must handle tool/function calling for full functionality; if it's a weaker model, expect simpler answers rather than failures — all the harness defenses (arg validation, iteration caps) apply to it too.
- `ASSISTANT_FALLBACK_MODEL` defaults to `ASSISTANT_MODEL` when unset, and the key is only needed for auth-protected backups.
- `LIVE_INCIDENTS_URL`: Live incident feed for the `get_live_incidents` tool (default: `https://chains-status-news.johnaverse.cc`)
- `FORUM_NEWS_URL`: Forum/governance news feed for the `get_forum_news` tool (default: `https://chains-forum-news.johnaverse.cc`)
- `WEB3_NEWS_URL`: Ecosystem/editorial news feed for the `get_web3_news` tool (default: `https://chains-news.johnaverse.cc`). In-cluster deployments should set this to the Service DNS name.
- `WEB3_NEWS_CACHE_TTL_MS` / `WEB3_NEWS_FETCH_TIMEOUT_MS`: cache window and per-request timeout for that feed (defaults `60000` / `10000`)

### Other
- `BODY_LIMIT`: Maximum request body size in bytes (default: 1048576 = 1 MB)
- `MAX_PARAM_LENGTH`: Maximum URL parameter length (default: 200)
- `MAX_SEARCH_QUERY_LENGTH`: Maximum search query length (default: 200)
- `CORS_ORIGIN`: Allowed CORS origins (default: `*` for all origins)

See `.env.example` for a complete list of environment variables with example values.

## API Endpoints

### `GET /`
Get API information and available endpoints.

**Response:**
```json
{
  "name": "Chains API",
  "version": "1.1.1",
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

### `GET /assistant`
Assistant availability probe: `{"enabled": true, "model": "qwen3"}` (`enabled: false` when no LLM is configured).

### `POST /assistant/chat`
Chat with the assistant. Stateless — send the full conversation each turn; the assistant may reply with a clarifying question (e.g. mainnet vs testnet) that you answer in a follow-up message.

Fast answers return `200` with the result directly. Runs that outlive the sync window (`ASSISTANT_SYNC_WAIT_MS`, default 8s — typical for large local models) return `202 {"jobId", "status": "running", "pollAfterMs"}`; poll `GET /assistant/chat/:jobId` until `status` is `done` (result fields included) or `error`. This keeps every HTTP request short, so reverse-proxy/CDN timeouts never kill a slow LLM run.

**Request:**
```json
{
  "messages": [{ "role": "user", "content": "is base healthy right now?" }],
  "context": { "view": "networks", "chainId": 8453 }
}
```

**Response:**
```json
{
  "reply": "Base mainnet (`8453`): 5/5 monitored RPC endpoints healthy…",
  "toolCalls": [{ "name": "get_rpc_monitor_by_id", "args": { "chainId": 8453 } }],
  "degraded": false,
  "usage": { "promptTokens": 1874, "completionTokens": 96 }
}
```

Errors: `503` when not configured or the LLM is unreachable, `429` on rate limit, `400` on invalid payloads.

### `GET /rpc-monitor`
Get RPC endpoint monitoring results for all chains. At startup, a background process validates the health of the indexed RPC endpoints.

**Response:**
```json
{
  "isMonitoring": false,
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "totalEndpoints": 4236,
  "testedEndpoints": 850,
  "workingEndpoints": 782,
  "results": [
    {
      "chainId": 1,
      "chainName": "Ethereum Mainnet",
      "url": "https://eth.rpc.pinax.network",
      "status": "working",
      "clientVersion": "geth/v1.14.0",
      "blockNumber": 19123456,
      "testedAt": "2026-02-07T14:13:42.104Z"
    },
    ...
  ]
}
```

### `GET /rpc-monitor/:id`
Get RPC monitoring results for a specific chain by its chain ID.

**Example:** `GET /rpc-monitor/1` (Ethereum)

**Response:**
```json
{
  "chainId": 1,
  "chainName": "Ethereum Mainnet",
  "totalEndpoints": 15,
  "workingEndpoints": 12,
  "lastUpdated": "2026-02-07T14:13:42.104Z",
  "endpoints": [
    {
      "url": "https://eth.rpc.pinax.network",
      "status": "working",
      "clientVersion": "geth/v1.14.0",
      "blockNumber": 19123456,
      "error": null,
      "testedAt": "2026-02-07T14:13:42.104Z"
    },
    ...
  ]
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
  "status": "active",
  "bridges": [
    {
      "url": "https://bridge.polygon.technology/"
    }
  ]
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
  "status": "active",
  "bridges": [
    {
      "url": "https://bridge.polygon.technology/"
    }
  ]
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

### `GET /export`
Export the disk cache snapshot file (`DATA_CACHE_FILE`) as JSON.

Returns:
- `200` with JSON snapshot content when the file exists
- `404` when the cache file does not exist
- `503` when cache is disabled (`DATA_CACHE_ENABLED=false`)

**Response (example):**
```json
{
  "schemaVersion": 1,
  "writtenAt": "2026-02-23T12:34:56.000Z",
  "data": {
    "lastUpdated": "2026-02-23T12:34:56.000Z",
    "indexed": {
      "byChainId": {},
      "byName": {},
      "all": []
    }
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
- `bridges`: Array of bridge URLs (if available from chainlist or chains.json `parent.bridges` field)

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

## Documentation

More detailed information about project internals and testing can be found in the `docs` folder:

- [Project Structure](docs/PROJECT_STRUCTURE.md): Detailed explanation of files and directories
- [Testing](docs/TESTING.md): Comprehensive guide to the testing strategy (Unit, Integration, and Fuzz testing)

## Contributing

We welcome contributions to the Chains API project! Whether you're fixing bugs, improving documentation, or proposing new features, your contributions are appreciated.

### How to Contribute

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** with clear, descriptive commit messages
3. **Add or update tests** to cover your changes
4. **Ensure all tests pass** by running `npm test`
5. **Verify code quality** - your changes will be automatically scanned by SonarQube
6. **Submit a pull request** with a clear description of your changes

### Code Quality Standards

All contributions must meet our quality standards:
- ✅ All tests must pass (300+ test cases)
- ✅ Code coverage ≥ 80%
- ✅ Code duplication ≤ 3%
- ✅ No critical code smells or security vulnerabilities
- ✅ Cognitive complexity within acceptable limits

These standards are automatically enforced through our CI/CD pipeline and SonarQube analysis.

### Areas for Contribution

- 🐛 Bug fixes and issue resolution
- 📚 Documentation improvements
- ✨ New features and enhancements
- 🧪 Additional test coverage
- 🔍 Data validation and quality improvements
- 🌐 Support for additional blockchain networks

### Questions or Issues?

If you have questions or encounter issues, please [open an issue](https://github.com/Johnaverse/chains-api/issues) on GitHub.

## License

MIT

