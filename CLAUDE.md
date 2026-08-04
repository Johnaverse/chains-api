# CLAUDE.md — Chains API

## Project Overview

Chains API is a Node.js service that aggregates blockchain chain data from five external sources, maintains an in-memory index, and exposes it via a REST API (Fastify), MCP stdio server, and MCP HTTP server. No database — data is fetched from remote JSON/Markdown sources, indexed in memory, and optionally cached to disk for stale-first startup.

**Single data source per container:** `server.js` runs the REST API and the MCP HTTP server in **one process** (default `npm start` / Docker `CMD`). Both surfaces read the same module-level in-memory store (`src/store/`), and only the REST side starts the refreshers — so a container never refreshes the same public RPC endpoint twice. `index.js` (REST only) and `mcp-server-http.js` (MCP only) remain runnable standalone for local/dev use. The MCP tool surface in `mcp-tools.js` mirrors the REST read endpoints (chains, search, relations, endpoints, clients, scaling, slip44, status-pages, stats, keywords, rpc-monitor, refresher, validate, live-incidents, forum-news).

**Upstream feed services (separate deployables):** live incidents and forum news do **not** come from the five data sources — they are served by two sibling Node services with their own repos, releases, and containers:

| Service | Feeds | Consumed via |
|---------|-------|--------------|
| `chains-status-news` | Chain + RPC-provider status pages → incidents, scheduled maintenance | `LIVE_INCIDENTS_URL` |
| `chains-forum-news` | Official community/governance forums, keyed by chain ID | `FORUM_NEWS_URL` |

The wire contract shared by all three services — addressing, health/readiness, versioning, collection envelopes, error shape, WebSocket framing, timestamps, auth — is specified in [`docs/SERVICE-CONTRACT.md`](docs/SERVICE-CONTRACT.md). Read it before changing any cross-service payload.

Both are **independent git repos**, so they are often checked out next to this one in the same working tree (`chains-status-news/`, `chains-forum-news/`) — useful for cross-checking a feed's payload against a consumer here. They are versioned and released separately from this project, and the paths in this document, in `package.json`, and in `.github/workflows/` are all relative to *this* project's root.

Each is consumed on **two independent paths**, which is easy to miss:

1. **Server-side** — `src/sources/liveIncidents.js` and `src/sources/forumNews.js` poll the feeds' REST endpoints behind a short in-memory cache, so the MCP tools (`get_live_incidents`, `get_forum_news`) and the assistant have the same data. `forumNews.js` is WebSocket-first (lazy persistent `/ws` subscription, REST only to seed or when the socket is down).
2. **Client-side** — the dashboard (`public/app.js`) connects to the same services' `/ws` **directly from the browser**, with the hosts hardcoded as `STATUS_NEWS_BASE` / `FORUM_NEWS_BASE`. Changing a feed host therefore needs edits in *both* `config.js` (server) and `public/app.js` (dashboard).

`chains-status-news` can also stream a second-phase `status.enrichment` message per event (LLM classification: `class`, `severity`, `confidence`, `summary`, `context.actionRequired`) keyed by the raw `eventId`; the dashboard upgrades incident cards in place when it arrives. Events also carry a normalized lifecycle `status` and an `ongoing` boolean — prefer those over parsing incident text.

**Assistant (optional):** `POST /assistant/chat` runs an LLM tool-use loop (`src/services/assistant.js`) over the same tool registry, against any OpenAI-compatible server (Ollama). Disabled unless `ASSISTANT_LLM_URL` is set; an optional fallback provider (`ASSISTANT_FALLBACK_LLM_URL`) takes over mid-run when the primary fails. The dashboard consumes it via a floating chat overlay (corner button, available on every view); the harness disambiguates mainnet/testnet and live-vs-static questions, asking the user back when unclear.

## Quick Reference

```bash
npm install          # Install dependencies (Node >=20 required)
npm start            # Start combined server: REST API (3000) + MCP HTTP (3001), one process
npm run start:rest   # Start ONLY the REST API on port 3000 (node index.js)
npm run dev          # Start combined server with --watch for auto-reload
npm run mcp          # Start MCP stdio server
npm run mcp:http     # Start ONLY the MCP HTTP server on port 3001
npm test             # Run all tests (vitest run)
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with v8 coverage report
npm run lint         # ESLint on src/
npm run openapi      # Regenerate public/openapi.json from the route schemas
```

**Dashboard:** `public/` is a dependency-free vanilla-JS dashboard (no build step, no framework). The running server mounts it at **`/ui/`** — not `/` (which returns the API info JSON), so browse `http://localhost:3000/ui/`. The same directory is published to GitHub Pages by `static.yml`, which is how it reaches production; a dashboard-only change still needs a release to appear on the Pages site.

**API docs:** Every route's JSON Schema feeds `@fastify/swagger` — interactive Swagger UI at `/docs`, raw spec at `/openapi.json`. Routes are auto-tagged by path (no per-route `tags` needed). `npm run openapi` writes `public/openapi.json`; CI regenerates it for the GitHub Pages reference (`/api-docs.html`, Redoc) and fails the build if the committed copy is stale.

## Architecture

The codebase is organized into a layered `src/` structure. Legacy root-level files (`dataService.js`, `index.js`, `mcp-tools.js`, etc.) remain as thin facades that re-export from `src/` so older imports and tests keep working.

```
External HTTP sources
        ↓
src/transport/fetch.js          ← proxy-aware fetch wrapper
        ↓
src/sources/{l2beat,slip44}.js  ← per-source parsers / fetchers
        ↓
src/store/                      ← in-memory index + disk cache
  ├─ indexer.js                 (build indexed.byChainId / byName / all)
  ├─ queries.js                 (search, getChain, getRelations, …)
  ├─ cache.js                   (stale-first disk persistence)
  └─ snapshot.js                (export / reload coordination)
        ↓
src/domain/                     ← pure business logic
  ├─ relations.js               (l2Of, testnetOf, parentOf, mainnetOf)
  └─ keywords.js                (search keyword index)
        ↓
src/services/                   ← background tasks
  ├─ chainRefresher.js          (unified rolling RPC + L2BEAT refresher)
  ├─ rpcHealth.js               (RPC liveness checks)
  ├─ l2beatRefresher.js         (legacy shim → chainRefresher)
  ├─ validation.js              (17 cross-source validation rules)
  ├─ assistant.js               (LLM tool-use harness for /assistant/chat)
  ├─ assistantTools.js          (mcp-tools → OpenAI tools adapter + AJV arg validation)
  └─ loader.js                  (initial data load)
        ↓
src/http/                       ← Fastify routes
  ├─ app.js                     (Fastify factory)
  └─ routes/*.js                (one file per resource)
```

## Tech Stack

- **Runtime:** Node.js >=20, ES Modules (`"type": "module"`)
- **HTTP:** Fastify v5 (REST API), Express v5 (MCP HTTP server)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.26+
- **Logging:** pino structured JSON logs (no `console.*` in src/)
- **Validation:** AJV via Fastify's JSON Schema, with `ajv-errors` for friendly messages
- **Testing:** Vitest v4 with `@vitest/coverage-v8`, `fast-check` for property-based fuzz tests
- **Linting:** ESLint v10 (`eslint.config.js`, flat config)
- **CI/CD:** GitHub Actions — test, SonarQube scan, Docker build/push to GHCR
- **Containerization:** Docker (node:20-alpine), Docker Compose

## Data Sources

1. **TheGraph Networks Registry** — Network/subgraph endpoint data
2. **Chainlist** — RPC endpoint lists (`rpcs.json`)
3. **Chain ID Network** — Basic chain metadata (`chains.json`)
4. **SLIP-0044** — Coin type registry (parsed from Markdown table)
5. **L2BEAT** — L2 classification (stage, category, stack, DA layer, TVS, activity); live API with checked-in fallback at `data/l2beat-fallback.json`

Source URLs are configurable via `DATA_SOURCE_*` environment variables (see `config.js`).

## Testing

**Framework:** Vitest with globals enabled (no explicit imports needed for `describe`, `it`, `expect`).

```
tests/
├── unit/
│   ├── store/         (indexer, cache, queries)
│   ├── sources/       (l2beat, slip44)
│   ├── services/      (chainRefresher, l2beatRefresher, validation)
│   ├── domain/        (relations)
│   ├── http/          (admin, metrics, helpers)
│   ├── transport/     (fetch)
│   ├── dataService.test.js   (legacy facade)
│   └── index.test.js          (legacy facade)
├── integration/       (full API + api.fuzz.test.js property tests)
├── fixtures/          (shared test data)
└── helpers/           (test utilities)
```

**Conventions:**
- New tests live under `tests/unit/<layer>/` matching the source path
- Test timeout: 30 seconds (configured in `vitest.config.js`)
- Coverage target: ≥80% line coverage (enforced by CI/SonarQube)
- All tests must pass before Docker image is built in CI

**Running a single test file:**
```bash
npx vitest run tests/unit/store/indexer-l2beat.test.js
```

## Code Conventions

- **ES Modules only** — `import`/`export`, not `require`
- **No build step** — source files run directly with Node
- **Config via environment** — all tunables go through `config.js` with typed parsing
- **Structured logging** — `import { logger } from '../util/logger.js'`; never `console.log` in `src/`
- **Schema-first routes** — every Fastify route declares a JSON Schema for `querystring`/`params`/`body`; typos like `?tags=` (vs `?tag=`) return 400
- **Rate limiting** — global, search, and reload endpoints each have separate limits

## Environment Variables

Copy `.env.example` to `.env` for local configuration. Key variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | REST API port |
| `MCP_PORT` | `3001` | MCP HTTP server port |
| `CORS_ORIGIN` | `*` | Allowed CORS origins |
| `PROXY_URL` | (empty) | HTTP/HTTPS proxy URL |
| `DATA_CACHE_ENABLED` | `true` | Enable disk caching |
| `DATA_CACHE_FILE` | `.cache/chains-api-data.json` | Cache file path |
| `LOG_LEVEL` | `info` | pino log level |
| `CHAIN_REFRESHER_TICK_MS` | `1000` | Unified refresher tick interval |
| `DATA_SOURCE_L2BEAT_API` | `https://l2beat.com/api/scaling/summary` | L2BEAT endpoint |
| `L2BEAT_FETCH_TIMEOUT_MS` | `10000` | L2BEAT live fetch timeout |
| `RPC_MONITOR_LOOP` | `false` | Enable continuous RPC monitoring (legacy; superseded by chainRefresher) |
| `SOURCE_FETCH_MAX_RETRIES` | `3` | Attempts per source fetch before it's treated as failed |
| `SOURCE_FETCH_RETRY_BASE_MS` | `500` | Backoff base for source-fetch retries (`base × 2^(attempt-1)`) |
| `SOURCE_REFRESH_INTERVAL_MS` | `900000` | Self-heal interval: re-fetch sources if any failed to load (0 disables) |
| `ASSISTANT_LLM_URL` | (empty) | OpenAI-compatible LLM server (e.g. Ollama `http://localhost:11434`); empty disables the assistant |
| `ASSISTANT_LLM_API_KEY` | (empty) | Bearer token for key-protected LLM servers (OpenAI, OpenRouter, …) |
| `ASSISTANT_MODEL` | `qwen3` | Model name for `/v1/chat/completions` |
| `ASSISTANT_TOPIC_GUARD` | `true` | Pre-classification call that refuses off-topic questions before the tool loop |
| `ASSISTANT_FALLBACK_LLM_URL` | (empty) | Optional backup LLM server; runs switch to it (sticky) when the primary fails |
| `LIVE_INCIDENTS_URL` | `https://chains-status-news.johnaverse.cc` | Live incident feed used by the `get_live_incidents` tool |
| `FORUM_NEWS_URL` | `https://chains-forum-news.johnaverse.cc` | Forum/governance news feed used by the `get_forum_news` tool |

See `config.js` and `.env.example` for the full list.

## CI/CD Pipeline

GitHub Actions workflows in `.github/workflows/`:

1. **`docker-build.yml`** — On push to main/tags/PRs: runs `npm ci`, `npm run test:coverage`, SonarQube scan, then builds and pushes Docker image to GHCR
2. **`static.yml`** — Deploys `public/` to GitHub Pages on push to main
3. **`auto-tag.yml`** — Auto-creates git tags from `package.json` version on main

**Quality gates:** Coverage ≥80%, duplication ≤3%, no critical security vulnerabilities.

## Releasing / Deploying

Merging to `main` does **not** deploy. Flux rolls out only when a **new** semver tag appears, and `auto-tag.yml` derives that tag from `package.json` — so if the version already equals the latest tag, a merge produces no tag and nothing ships. Cutting a release:

1. Bump `version` in `package.json` (`npm version patch --no-git-tag-version`).
2. Run **`npm run openapi`** and commit the result. `public/openapi.json` embeds `pkg.version`, and `docker-build.yml` regenerates it and **fails the build** if the committed copy differs — so every version bump also changes that file.
3. Open a PR: `main` is branch-protected, so a direct `git push origin main` is rejected. Merge it, and `auto-tag.yml` creates `vX.Y.Z` → Docker image → Flux.

Note the two deploy paths move at different speeds: `static.yml` publishes the dashboard as soon as `main` moves, while API/MCP changes wait on the image build plus Flux reconciliation. A `/ui/` fix can therefore be live while the API is still on the previous version.

## Docker

```bash
docker compose up             # Start both REST API and MCP HTTP server
docker compose up chains-api  # Start only the REST API
```

Services: `chains-api` (port 3000) and `chains-api-mcp` (port 3001). Both have health checks on `/health`.

## API Endpoints (REST)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info |
| GET | `/health` | Per-source freshness + per-refresher status + overall `ok`/`degraded`/`down` |
| GET | `/sources` | Data source loaded state |
| GET | `/chains` | All chains (optional `?tag=`) |
| GET | `/chains/:id` | Chain by ID |
| GET | `/search?q=` | Search chains |
| GET | `/endpoints` | All endpoints |
| GET | `/endpoints/:id` | Endpoints by chain |
| GET | `/relations` | All chain relations |
| GET | `/relations/:id` | Relations by chain |
| GET | `/relations/:id/graph` | Relation subgraph for chain |
| GET | `/slip44` | All SLIP-0044 coin types |
| GET | `/slip44/:coinType` | Coin type by ID |
| GET | `/scaling` | L2BEAT projects |
| GET | `/scaling/:id` | L2BEAT project by chain ID |
| GET | `/scaling/status` | L2BEAT refresh status |
| GET | `/status-pages` | Curated operator status/incident pages (chains + coins) |
| GET | `/status-pages/:id` | Status page for a chain (by chainId) |
| GET | `/status-pages/symbol/:symbol` | Status page for a coin not keyed by chainId (e.g. `SOL`) |
| GET | `/clients` | Execution-client registry |
| GET | `/clients/:id` | Client by id |
| GET | `/rpc-monitor` | RPC health results |
| GET | `/rpc-monitor/:id` | RPC results by chain |
| GET | `/keywords` | Indexed search keywords |
| GET | `/stats` | Aggregate counts: totals by tag, plus `byStatus` / `activeChains` / `deprecatedChains` and RPC health |
| GET | `/summary` | Slim dashboard projection (chains + L2BEAT headline), ETag/304 |
| GET | `/validate` | Run 17 cross-source validation rules |
| GET | `/export` | Export cached data |
| GET | `/metrics` | Prometheus exposition (counters + gauges) |
| GET | `/refresher` | Unified refresher cursor + queue depth |
| GET | `/assistant` | Assistant availability probe (`{enabled, model}`) |
| POST | `/assistant/chat` | LLM chat over the registry + live incidents (stateless; 200 inline or 202 + job id for slow runs) |
| GET | `/assistant/chat/:jobId` | Poll an async assistant job (running/done/error) |
| GET | `/docs` | Interactive API reference (Swagger UI) |
| GET | `/openapi.json` | OpenAPI 3 specification (machine-readable) |
| POST | `/reload` | Reload all data sources |

## Common Tasks

**Add a new API endpoint:** Create or edit a file in `src/http/routes/`, declare the JSON Schema, register the route. Add tests in `tests/unit/http/` and/or `tests/integration/api.test.js`.

**Add a new MCP tool:** Define schema and handler in `mcp-tools.js`. Both MCP servers (`mcp-server.js`, `mcp-server-http.js`) consume tools from this shared module, and `src/services/assistantTools.js` adapts the same registry into OpenAI tool definitions for the assistant — so a new tool reaches all three surfaces at once. Tool *descriptions* are prompt surface: the assistant relies on them (plus the rules in `buildSystemPrompt`) to pick a tool, so state what a field means and when to use it.

**Sizing tool responses:** the registry holds ~3000 chains, and dumping a full collection into an LLM's context makes it lose track of totals. List-style tools therefore return a **capped sample plus honest counts** — `get_chains` defaults to 50 (max 200) and returns `totalMatched` / `count` / `truncated`, and its description tells the model to say it is showing a subset. Keep that shape for any new collection tool, and put exact aggregates in `get_stats` (which reports `totalChains`, `byStatus`, `activeChains`, `deprecatedChains` and RPC health) rather than making the model count rows.

**Add a new data source:** Add a fetcher under `src/sources/`, an indexer pass in `src/store/indexer.js`, wire it into `src/services/loader.js`, expose any user-facing data via a new route in `src/http/routes/`. Update `config.js` for the source URL and add tests under `tests/unit/sources/` and `tests/unit/store/`.

**Modify environment config:** Edit `config.js` using the existing `parseIntEnv`/`parseStringEnv`/`parseBooleanEnv` helpers. Update `.env.example` with the new variable and default.

**Add a validation rule:** Add the rule to `src/services/validation.js`, increment the rule count in tests, expose a per-rule counter via `src/util/metrics.js` so `/metrics` tracks it.
