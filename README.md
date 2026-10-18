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
- **get_chain_by_id**: Get detailed information about a specific blockchain chain by its chain ID (with its `research` block, minus the hardware profiles and with at most 12 compact `channels` (one per platform before any repeats) plus `channelsTotal` and `channelsByPlatform`; dated compact `availability` observations with `channelsAvailabilityNote` retain closure/unknown states and cache caveats; `hasNodeRequirements` says whether to call the next tool)
- **get_node_requirements**: Documented hardware/system requirements for running a node on a chain, from the node hardware research — one profile per role (`full_node`, `validator`, `archive`, `rpc`, …) × tier (`minimum` / `recommended` / `example`) × client, most specific first, optional `role` / `level` filters and a `limit` (default 8). Role filtering also includes explicitly sourced `prerequisiteFor` links: Nibiru validator lookups include its full-node prerequisite under the original `full_node` role, counted once. The link's `sizing: "not_established"` does not claim dedicated validator hardware. Requirements come back as strings in the publisher's original units (`"memory capacity: 16 GB"`) and are never converted. Also carries `software`: the node/client `repositories` the research tied to the chain (with `kind` and `status`) and `observedClients`, the client software and versions seen on the chain's live RPC endpoints (evidence of what operators run, not a requirement). Compact JSON on purpose: the dashboard assistant caps tool results at `ASSISTANT_TOOL_RESULT_MAX_CHARS`
- **search_chains**: Search for blockchain chains by name or other attributes
- **get_endpoints**: Get RPC, firehose, and substreams endpoints for a specific chain or all chains
- **get_client_releases**: Recent node/client software releases from chains-client-feed (via `CLIENT_FEED_URL`), newest first — version/tag, `prerelease`, `mandatory`, the AI summary and any hard fork the notes announce (`fork`: name, network, activationAt/Block/Epoch/Slot, state). Filters: `client` (resolved to its registry repositories), `repo` (`owner/repo` or `github:` / `gitlab:` prefixed), `chainId`, `fork`, `since` / `until` (inclusive ISO dates; a bare `until` covers that day); capped (default 15, max 50) with `totalMatched` / `truncated`
- **get_network_clients**: Client repositories known to serve a chain, each with the kinds it plays there, `networkCount`, latest release, latest fork and a compact development `activity` (chains-client-feed's client → networks index)
- **get_client_activity**: How actively a client is developed (default-branch commits and merged PRs in 30/90 days), its open issues and PRs, open issues labeled bug or critical/security, published GitHub security advisories, and an activity and attention level with reasons — by `repo` or by `client` name (refreshed daily by chains-client-feed; GitHub needs the feed's `GITHUB_TOKEN`)
- **get_l2_metrics**: Ethereum L2 data from [growthepie](https://www.growthepie.com) (~26 chains): rank chains by any metric (`daa`, `txcount`, `tvl`, `stables_mcap`, `fees_paid_usd`, `profit_usd`, `rent_paid_usd`, `costs_blobs_usd`, `txcosts_median_usd`, …) with 7-day change and the all-L2 total; one chain in full (`chainId`: profile, every metric with 7d/30d change, current fees, users, revenue/costs/profit, blockspace by category, DA layers used, optional daily history via `metric` + `days`); `view: "da"` for data-availability layers; `view: "eth_supply"`. Every answer carries `attribution`
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
- `GET /upgrades?chainId=&network=&limit=`: cross-feed upgrade timeline — scheduled upgrades/maintenance with required software (`[{client, version}]`), urgency, activation time, incidents that followed on the same network within 24h (`suspectedCause: "upgrade"` — temporal correlation, not asserted causation), and related forum/news context. `network` accepts a name for chains with no EVM chain ID ("Solana", "Canton"). Also exposed as the `get_chain_upgrades` MCP tool.
- `GET /forks?chainId=&phase=&scheduledOnly=&include=&limit=`: forks as ENTITIES — one entry per fork per network, grouped across all three feeds (status pages and provider windows from chains-status-news, governance/research posts from chains-forum-news, articles from chains-news, and — when `CLIENT_FEED_URL` is set — client release notes and changelogs from chains-client-feed, each fetched with `?fork=true`; a release attributed only to its repository's networks, with three or more of them and none named in the notes, is left unscoped rather than filed under each), so a fork that six providers, a forum thread and the project blog announced appears once. Grouping is by codename ("Glamsterdam" = "the Glamsterdam upgrade"), else activation height, else exact stated instant; unnamed notices on one network within six hours of each other — every one within 6h of the cluster's earliest time, so a run of notices cannot chain into a day-long fork — (or at the same height) are one fork, and fold into the named fork on that network at the same activation. The network's own sources and primary outlets outrank provider windows, which outrank secondary news, when they disagree on the date — except that newer status, forum or primary sources moving the date by more than a day count as a reschedule. When a source names the forking network (`fork.network`), the fork is filed under that network's chains, not the poster's: an Arbitrum post about Ethereum's fork is a chain 1 fork, and its date ranks as indirect (like secondary news), not as Ethereum's own. A test-network fork never inherits the mainnet chain of a post that only names the mainnet. A name made only of generic words ("Network Upgrade") is treated as unnamed. A named mention with no network at all folds into the single network-scoped fork of that name; groups made of exactly the same events (one window naming three networks) are one entry listing every network in `networks`; each fork's `events` are de-duplicated by URL. Only real forks are listed by default (`kind: "fork"`): a group counts as a fork when any member is classed `planned_hard_fork` (or legacy `hard_fork`), when no member carries a class at all, when it activates at a block height, or when it has a real name (not generic, not a version number like `v29.0.1`) AND a stated activation; every other marked group — client releases, RPC patches, provider infrastructure work classed `planned_software_update` — is `kind: "upgrade"`, listed only with `include=upgrades`, and `byKind` counts both. A stated activation more than 30 days before the post that states it is dropped as implausible (the classifier guessing a year) unless the fork is `completed`; the dropped value stays visible as the event's `implausibleActivationAt`. A claim's time for "newest wins" is the enrichment's `createdAt`, else `publishedAt` (never `updatedAt`, which some providers set to the future window start), capped at now. A date-only activation is `activationPrecision: "day"` and stays `upcoming` until that UTC day ends; `state: completed` is always `past`. chains-news' `enrichment.forks` (several activations in one post) is read as one mention per entry. Each fork lists `feeds` and its `events` with each source's claimed `activationAt`; the response's top-level `feeds` says which feeds answered this round (`ok`), and `stale: true` marks a feed whose forks are left over from an earlier fetch; `filtered` says whether the feed honoured `?fork=true` (a 400 is remembered for an hour, so the filtered request is not retried on every refresh) and `oldest` is the oldest item in the page read — when unfiltered, forks announced before it are not visible. Carries `activationAt` **with** `activationEvidence` (`stated` / `observed` from a reached block height / `estimated` from a future one — approximate, not a schedule), `activationBlock`, `state`, lifecycle `phase` (`upcoming`/`past`/`cancelled`/`unscheduled`) and `sources`. `scheduledOnly=true` for a calendar view; `byPhase` counts cover everything matched, not just the page. Also exposed as the `get_forks` MCP tool.
- `GET /timeline?chainId=&type=&phase=&since=&until=&limit=`: the event timeline — `hardfork` (a fork entity from `/forks`), `software_update` (a client version rolled out with no fork behind it, each provider's window for that version on that network grouped into one event — planned work, never an incident) and `maintenance` (a provider window naming no software). Under each event: `releases` (the client releases that ship it), `providerUpdates` (each provider's rollout window), `news` (articles and forum posts) and `followedByIncidents` (incidents on the network within 24h after activation, suspected only), with `counts` of each. A provider window or release joins a fork only on a network the fork shares, and only by being one of its status posts, by naming a version one of its releases ships, or by naming the fork; never by time alone, and a window never widens a fork to the other networks it covers. One fork named per layer (`Amsterdam` / `Gloas` → `Glamsterdam`, `layerName` keeps the client's name) or spelled two ways on the same chains is one event; an undated release adding support for a named fork joins that fork when its chain, or a single mainnet activation, says which. A fork network given only as "Mainnet" / "Testnet" is read as the one chain of that kind the release names (it used to resolve to chain 1 through The Graph's `mainnet` id). Release history is paged back with `?until=` past the newest 500 fork-tagged releases (re-read hourly), so `?chainId=…&type=hardfork` is the chain's hardfork history as far back as the client feed's archive reaches; provider posts reach back only weeks. A plain client release becomes its own event only when it is an urgent fix or mandatory. `sources` says which feeds answered; `byType`/`byPhase` count everything matched before the phase/date filters. Also the `get_timeline` MCP tool (default 5 events, group lists sampled to 2) and the dashboard's Timeline view and chain-drawer Hardforks section.
- Planned work is never an incident: a status event whose enrichment confidently classes it `planned_software_update`, `planned_hard_fork`, `urgent_software_fix` or `scheduled_maintenance` (or the legacy `software_update` / `hard_fork`) counts as maintenance whatever its status — in `/upgrades`, `/providers/stats`, the chain-level correlation of `get_live_incidents` and the dashboard Incidents view (`src/domain/plannedWork.js`). A low-confidence class does not override the status; the incident sentinel's S2 lists the events this moves.
- `CLIENT_FEED_URL`: Blockchain client release feed (chains-client-feed), read by `/forks` / `get_forks`, the `/client-releases` proxy routes and the `get_client_releases` / `get_network_clients` tools (default: unset = not read, and the proxy answers 503; there is no public host). `CLIENT_FEED_FETCH_TIMEOUT_MS` (default 10000), `CLIENT_FEED_CACHE_TTL_MS` (default 60000: how long the proxy holds one upstream answer; the last good answer is served, with `stale: true`, while the feed is down).
- `GET /repositories`: per chain, the research's node/client repositories and the hardware research's client names and evidence links — the raw input chains-client-feed builds its client registry and client → networks index from.
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
- `family` (optional): Filter by technology family from the research dataset. Labels are free text (`OP Stack / Zora`, `Matchain / OP Stack`), so this is a case-insensitive substring match: `?family=op stack` finds every OP Stack chain

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
Get a specific chain by its chain ID. Unlike the list, the single-chain response also carries the chain's `research` block when it has research items or a hardware research entry (including checks that found no profile; see below). `price` is the native-asset quote or `null` when unavailable. The OpenAPI response schema documents the `200` detail and `400` / `404` error bodies; optional source metadata is retained rather than stripped by response serialization.

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
  ],
  "price": null
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

### `GET /l2-metrics`
Ethereum L2 data from [growthepie](https://www.growthepie.com) (chain-level, public "Basic" tier). **growthepie must be credited wherever this data is shown**; every response carries `attribution`. Covers ~26 chains (Base, Arbitrum One, OP Mainnet, zkSync Era, Scroll, Linea, Unichain, Mantle, Celo, MegaETH, Robinhood Chain, Polygon PoS, Starknet, Ethereum, …), joined by EVM chain ID; a chain it does not track is absent, not zero.

Read from eight growthepie files, each on its own cadence: `master.json` (profiles, daily), `fundamentals.json` (17 daily metrics, 90 days, hourly), `fees/table.json` (current fees, hourly), `landing_page.json` (users, ranks, all-L2 series, hourly), `economics.json`, `blockspace/overview.json`, `da_overview.json` (6-hourly) and `eim/eth_supply.json` (daily). A file that fails keeps its previous copy; one never read live is answered from `data/growthepie-fallback.json` (regenerate with `node scripts/update-growthepie-fallback.mjs`). `dataSource` is `live`, `partial`, `fallback` or `unavailable`.

- `GET /l2-metrics` — every chain, compact: `profile` headline (stack, DA layer, L2BEAT stage, chain type), latest value / date / `change7d` of `daa`, `txcount`, `tvl`, `stables_mcap`, `fees_paid_usd`, `profit_usd`, `rent_paid_usd`, `txcosts_median_usd`, `gas_per_second`, `throughput`, `market_cap_usd`, the median transaction fee, users and 30-day economics; plus the all-L2 `aggregate`, `metricsInfo` labels and blockspace `categories`.
- `GET /l2-metrics/:chainId?series=` — one chain in full: `profile` (company, technology, purpose, launch date, stack, DA layer, RaaS, maturity, L2BEAT stage/id/link, explorers, website), every fundamental metric with `change7d` / `change30d` (single day vs 7 / 30 days before — spiky on event days), `avg7d` and `avg7dChange` (7-day average vs the week before — the steadier trend) and the 90-day daily `series` (`?series=false` drops it), `fees` (median, native-transfer, swap and average transaction cost, TPS, throughput — newest hourly reading), `activity` (users, user share, cross-chain activity, rank per metric), `economics` per span (`1d` … `max`: revenue, total / L1 / blob costs, profit, margin, data posted), `blockspace` (gas fees and transactions by category per span), `daLayersUsed`; chain 1 also carries `ethSupply`.
- `GET /l2-metrics/da` — data-availability layers (Ethereum blobs, Celestia, EigenDA): fees, data posted, fee per MB and consumers per span, and the top consumers.
- `GET /l2-metrics/eth-supply` — ETH supply and issuance rate (latest and the last year daily) and the supply events.
- `GET /l2-metrics/status` — each file's `source` (`live` / `fallback`), fetch time and last error.

`/chains/:id` (and `get_chain_by_id`) carries the compact block as `l2Metrics` for covered chains. Configuration: `GROWTHEPIE_ENABLED` (default `true`), `GROWTHEPIE_API_URL` (default `https://api.growthepie.com/v1`), `GROWTHEPIE_FETCH_TIMEOUT_MS` (30000), `GROWTHEPIE_REFRESH_TICK_MS` (900000: how often due files are looked for).

### `GET /client-releases`
Proxy for chains-client-feed (the feed has no public host, so the dashboard reads it through here). Releases and changelog entries, newest first.

**Query:** `limit` (1–500, default 100), `fork` (`true` = only releases announcing a hard fork), `chainId`, `repo` (`owner/repo`, optionally `github:`/`gitlab:`-prefixed), `since` (ISO date or date-time). All passed through to the feed.

**Response:** `{fetchedAt, stale, count, items:[{id, url, title, publishedAt, source:{id, name, kind}, chains:[{chainId, name}], chainsFrom: "release"|"repository", release:{repo, tag, version, prerelease, mandatory}, enrichment:{class, createdAt, summary, fork, forks?}}]}`. `fork` is `{name, network, activationAt, activationBlock, state}` plus `activationEpoch` / `activationSlot` / `activationTimestamp` when the notes state them. Missing upstream fields come back as `null` / `[]`.

Related routes:
- `GET /client-releases/clients?q=&kind=&chainId=` — the client registry (repositories and name-only clients), each with `kinds`, `names`, `networkCount`, `latestRelease`, `latestFork`.
- `GET /client-releases/clients/:host/:owner/:repo` — one repository (`host` = `github` | `gitlab`; `owner` / `repo` = `[A-Za-z0-9_.-]+`, never only dots) with every network it serves (`networks:[{chainId, name, kinds, source}]`) — the reverse lookup. 404 when the feed does not know it.
- `GET /client-releases/networks/:chainId` — clients serving a chain, with the kinds each plays on that chain.

Errors: **503** `{error: "Client release feed not configured"}` when `CLIENT_FEED_URL` is unset; **502** when the feed fails and nothing is cached. Responses are cached per upstream URL for `CLIENT_FEED_CACHE_TTL_MS`.

**Dashboard:** Activity → **Releases** lists `/client-releases?limit=200` (the *Forks only* toggle re-reads with `fork=true`) with chain and client filters; each card shows the repo linked to its release, version/tag, `pre-release` / `mandatory` badges, published time, the AI summary, a fork line (name, network, activation — a time only when one was stated, plus block/epoch/slot/timestamp — and state) and its chains (labelled *Repository networks* when the notes named none). The chain drawer gains a **Clients** section from `/client-releases/networks/:chainId`, where *Supports N networks* expands the client's other networks (each opens that chain). Both stay hidden when the API answers 503.

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
- `infoURL`: Information URL. Where the research dataset moved a chain to a different website (or filled a missing one), this is the corrected one, with `infoURLSource: "research"` and the registry's original kept in `registryInfoURL`
- `family`: Technology family (e.g. `OP Stack-derived`), from the research dataset
- `sources`: Array of data sources that provided this chain's data
- `status`: Chain status - defaults to `"active"` when not present in any data source
- `tags`: Array of tags (e.g., "Testnet", "L2", "Beacon")
- `bridges`: Array of bridge URLs (if available from chainlist or chains.json `parent.bridges` field)

**Note:** Chain objects no longer include `rpc` or `relations` fields. Use `/endpoints/:id` for RPC endpoints and `/relations/:id` for relations.

#### `research` (from `/chains/:id` only)

A static, audited research dataset (`data/network-research.json`, ~3,000 chains), converted from the network research and verification workbook, plus the forum research (`data/forum-research.json`), the node hardware research (`data/node-hardware.json`) and the communication channel research (`data/channel-research.json`). Network research items include only checked/partial evidence whose audit was not unresolved; forums and channels include confirmed/qualified records. Hardware retains every researched entry and profile, including unresolved profiles and empty results with status, notes and sources. The block is omitted only when there are no research items or hardware research entry (`family` is still set on the chain itself). Optional raw metadata is retained at every level.

- `family`, `coverage` (`checked` / `partial` / `not_found` / `inaccessible`), `auditStatus` (`confirmed` / `qualified` / `corrected` / `unresolved` / `no_populated_claims_to_audit`), `checkedAt`, `updatedAt` (dataset date)
- `repositories[]`: node/client source — `url`, `repo` (`owner/name` for GitHub), `kind` (`node`, `execution`, `consensus`, `rollup`, `packaging`, `sdk`, `contracts`, `other`), `kindLabel` (original wording), `status`, `audit`, `evidence[]`
- `papers[]`: whitepapers and documents — `url`, `title`, `status`, `audit`, `evidence[]`
- `features[]`: short sourced statements — `text`, `status`, `audit`, `evidence[]`. These are project statements, not tested facts
- `forums[]`: discussion boards the forum research tied to the chain (from `data/forum-research.json`, ~600 chains) — `url`, `title`, `type` (`governance` / `community` / `developer` / `research` / `general`), `relationship` (`official` / `community_run` / `uncertain`), `scope` (`exact_network`, `project_family` = the project's shared board, `ecosystem_shared`, `historical_network`, `uncertain`), `access` (`read` / `inaccessible` / `archived` at research time), `activity` (`recent_activity_observed` / `historical_or_archived` / `unknown`), `lastActivity`, `verification` (`confirmed` / `qualified`), `notes`, `evidence[]`; plus `forumsCheckedAt`. Only confirmed or qualified records are included. This is research, not the polled registry: the chain's `forumUrl` still comes from the curated `data/forums.json`, which is what `chains-forum-news` reads
- `channels[]`: public community / developer / support routes the channel research found linked from a primary project source (from `data/channel-research.json`, ~1,400 chains), most specific first — `platform` (`discord`, `telegram`, `x`, `email` with a `mailto:` url, `slack`, `gitter`, `matrix`, `wechat`, `contact_form`, `other`), `url`, `canonicalUrl` (where the link resolves, when different), `title`, `mode` (`discussion` / `announcements` / `support` / `mixed` / `unknown`), `audience[]`, `language`, `relationship` (`official_operated` / `officially_endorsed` = linked by the project, not necessarily run by it / `community_run` / `uncertain`), `scope` (as for forums), `access` (`public_preview_read`, `public_discussion_read`, `invite_unverified`, `login_required`, `inaccessible`, `not_checked`, at research time), `invitation` (`verified_preview` / `official_link_unverified` / `not_applicable` / `unknown`), `lastActivity`, `alternateInvites[]`, `verification` (`confirmed` / `qualified`), `notes`, `evidence[]`; plus `channelsCheckedAt`. Optional `activity`, `checkedAt`, `evidenceMode`, `current_availability_checks[]` (including raw `activity_status`) and `independent_verification` retain the newer availability revision's evidence and timestamps. Only confirmed or qualified records are included and repurposed links are dropped. No channel was joined and nobody was contacted, so this is a discovery list, not evidence that a channel is active or answered. `get_chain_by_id` sends at most 12, compacted — each platform gets a slot before any repeats — with `channelsTotal` and per-platform counts in `channelsByPlatform`
- `hardware`: documented node sizing from the node hardware research (`data/node-hardware.json`, ~3,100 researched chains, ~900 with profiles; a chain with none still carries the research `status` (`not_found` / `inaccessible`), `notes` and checked `sources`) — `status`, `notes`, `sources[]`, `identityStatus` (`confirmed` / `qualified` / `unresolved`: how firmly the research tied the documentation to this chain), `checkedAt`, and `profiles[]`, one per role × tier × client: `role` (`full_node`, `validator`, `archive`, `rpc`, `collator`, `sequencer`, `prover`, `light_node`, `other`, `unspecified`), `level` (`minimum` / `recommended` / `example` / `unspecified`), `scope` (`exact_network` or `project_family` = the project's generic sizing, not verified for this exact network; `historical_network`; `uncertain`), `client`, `clientVersion`, `deployment` (`current` / `historical` / `deprecated` / `unknown`), `verification`, `notes`, `verificationNotes`, `evidence[]`, and `requirements[]` — `component` (`cpu`, `memory`, `storage`, `network`, `gpu`, `operating_system`, `other`), `metric` (`cores`, `vcpus`, `threads`, `capacity`, `storage_type`, `bandwidth`, `os_version`, …), `value` (number, string or boolean), `unit` **as published** (GB vs GiB, Mbps vs MB/s, cores vs vCPU are not interchangeable and are never converted), `qualifier` (`as_stated` / `at_least` / `at_most` / `approximately` / `range`, with `min` / `max` for ranges), `notes`, `source`. An omitted component means nothing was documented, never zero. `prerequisiteFor[]` links a profile to another role it supports (`role`, `requiredWhen`, `sizing`, `notes`, `sources`), preserving its original role and counting it once; Nibiru's full-node profile is a validator prerequisite, while the linked `sizing: "not_established"` means dedicated validator sizing remains undocumented. A profile can also be an extra component to run alongside the node: `requiredWhen` gives the condition (OP Mainnet's Legacy Geth / l2geth, for pre-Bedrock historical state), `sizing` says how far its hardware is documented (`explicit` / `partial` / `not_established` — such a profile may have no `requirements`), `historicalStateEra` the era it serves, `snapshotArtifact` a published download (`file`, `type`, `sizes[]` exactly as labelled — a download size, not a disk target), and `dependencies[]` the other services the node needs (`component`, `requiredWhen`, `clientOptions`, `selfHosted`, `hosting`, `sizing`). Every profile is included, `unresolved` ones too (`verification` `unresolved`: the source or its applicability was not settled — treat it as unverified); these are published requirements, not benchmarks. The dashboard does not render this block: it exists so the assistant and MCP clients can answer node setup questions, through the `get_node_requirements` tool

`status` is `checked` (fully verified) or `partial` (evidence gaps or uncertain applicability). `audit` is the item-level audit result: `confirmed`, `qualified` (family/historical/source caveats remain), `corrected` or null.

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

