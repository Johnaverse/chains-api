# Service contract

The canonical communication standard for the three services that make up this system.
They are **separate repos, separately released**, so nothing but this document keeps
their wire formats from drifting.

| Service | Role | Repo |
|---|---|---|
| `chains-api` | Registry hub: REST + MCP + assistant + dashboard | `Johnaverse/chains-api` |
| `chains-status-news` | Chain/RPC-provider status pages → incidents, maintenance | `Johnaverse/chains-status-news` |
| `chains-forum-news` | Community/governance forums, keyed by chain ID | `Johnaverse/chains-forum-news` |

Deployment manifests for all three live in `Johnaverse/johnaverse-fleet`
(`clusters/ca-lab-01/apps/<service>`), reconciled by Flux. They are **not** in the
service repos.

## Topology

The dependency is **bidirectional** — the most important thing to know before
changing any contract here:

```
                    browser (dashboard on GitHub Pages)
                      │  WS + REST, public hosts, needs CORS
        ┌─────────────┴──────────────┐
        ▼                            ▼
 chains-status-news           chains-forum-news
        │  ▲                         │  ▲
        │  │ CHAINS_API_URL          │  │ CHAINS_API_URL
        │  │ (chain catalog)         │  │ (chain catalog)
        │  └──────────┬──────────────┘  │
        │             ▼                 │
        └────────► chains-api ◄─────────┘
             LIVE_INCIDENTS_URL / FORUM_NEWS_URL
```

Both feeds fetch the chain catalog **from** `chains-api` to map prose to chain IDs,
while `chains-api` consumes their events. Neither side may hard-depend on the other
being up: each feed ships a bundled catalog snapshot fallback, and `chains-api`
serves stale cache when a feed is unreachable.

Each feed is consumed on **two independent paths**. Both must be considered when
changing a payload:

1. **Server-side** — `chains-api`'s `src/sources/{liveIncidents,forumNews}.js`
   (feeding the MCP tools and the assistant).
2. **Client-side** — the dashboard connects to the feeds' `/ws` **directly from the
   browser**, with hosts hardcoded in `public/app.js`.

## Rules

### 1. Addressing
In-cluster callers MUST use `http://<service>.<namespace>.svc.cluster.local:<port>`.
Only browsers use the public `*.johnaverse.cc` hosts. Every cross-service URL is an
explicit env var in the fleet ConfigMap — a code default MUST NOT point at the public
internet, because an unset var then silently leaves the cluster and hairpins back
through the Gateway to reach a Service in its own namespace.

### 2. Health vs readiness
Two distinct endpoints, never conflated:

- **`GET /health`** — liveness. Returns **200 whenever the process is alive**, and
  reports degradation in the body (`status: "ok" | "degraded"`). A liveness probe that
  can fail on a *data* problem causes restart loops that destroy the data further.
- **`GET /ready`** — readiness. **503** (`{status:"starting"}`) until the first
  successful data load, 200 after. A pod with an empty index answers queries
  truthfully but uselessly ("no chains", "no incidents"); readiness keeps it out of
  the Service's endpoints instead.

Probes MUST map liveness→`/health` and readiness→`/ready`.

### 3. Version
`GET /health` MUST include `version`, read from `package.json` at runtime. No
hardcoded version literals anywhere — every one that existed had already drifted
(an OpenAPI `info.version` of `1.0.0` against a real `0.1.5`, a User-Agent `0.1`
against a published `0.2.1`). Without this, the running build is only knowable from
the container image tag.

### 4. Collection responses
Any endpoint returning a capped list MUST return:

```json
{ "totalMatched": 2932, "count": 50, "truncated": true, "<items>": [ … ] }
```

- `totalMatched` — matches **before** the limit.
- `count` — number actually returned.
- `truncated` — `totalMatched > count`.

`count` alone is ambiguous: `count === limit` cannot be distinguished from a complete
answer. This is not theoretical — a capped list was once reported to a user as the
registry total. `limit` is validated: integer, default 50, max 500.

LLM-facing tools additionally MUST state the cap in their tool description, so the
model tells the user it is showing a subset rather than presenting it as the whole set.

### 5. Error envelope
Exactly one shape, everywhere:

```json
{ "error": "snake_case_code", "message": "optional human text" }
```

Register **both** `setErrorHandler` and `setNotFoundHandler` — otherwise Fastify's
default `{statusCode, error, message}` leaks from 404s and thrown handlers and the
service speaks two shapes. A domain-specific code plus useful extra context (e.g.
`{error:"invalid_class", knownClasses:[…]}`) is preferred over a generic
`invalid_query` where it helps the caller.

### 6. Query validation
Every route declares a JSON Schema for `querystring`/`params`/`body`, with
`additionalProperties: false` and Fastify's `removeAdditional: false`. An unknown or
typo'd parameter MUST be a **400**, never a 200 carrying unfiltered results — the
worst failure mode available, since it looks exactly like a successful answer.

### 7. WebSocket envelope
- Upgrade path `/ws`; anything else is destroyed.
- Every frame: `{ type, emittedAt, … }`.
- `hello` → `{ type, filters, replay, enrichment: boolean, serverTime }`. The
  `enrichment` flag tells a client whether phase two can ever arrive.
- Items → `<domain>.item` with the payload nested under `item`
  (`status.item`, `news.item`).
- Enrichment → `<domain>.enrichment`, keyed by `eventId`, fields spread at top level.
- Errors → `{ type: "error", error, message? }`, then `close(1008, error)` for a
  filter that can never match.
- `replay` is clamped to 100.

### 8. Enrichment taxonomy
The two feeds MUST share one `class` vocabulary and one `severity` scale
(`minor | major | critical`). They currently do **not** — status-news uses
`planned_hard_fork, chain_halt, provider_incident, …` while forum-news uses
`chain_incident, chain_hardfork, scheduled_maintenance, …` for the same domain. Until
unified, no consumer can filter across both feeds by class.

### 9. Timestamps
All timestamps on the wire are **ISO-8601 UTC**, normalized at ingest. Never pass an
upstream format through verbatim: RSS `pubDate` is RFC-822, so the same field would
otherwise carry two formats. `publishedAt` may be `null` when genuinely absent;
`updatedAt` falls back to ingest time. Durations/intervals are epoch-millisecond
numbers with an `Ms` suffix.

### 10. Auth
Any endpoint with side effects or outbound amplification requires a token
(`?token=` or a service-specific header), compared in constant time over fixed-length
digests. When the token is **unconfigured the route returns 404**, so the default
posture is closed rather than open. This matters because all three services are
routed publicly with `PathPrefix: /` — an unauthenticated refresh endpoint is a free
fan-out vector.

### 11. Network slugs
Cross-feed joins fall back to network NAMES when a chainId does not exist (Solana, Canton,
Zcash). Names only join if every service canonicalizes them identically, so the rule is part
of the contract: **lowercase → non-alphanumerics to spaces → strip trailing default-tier and
generic tokens (`mainnet`, `mainnets`, `network`, `chain`, `protocol`, `ledger`) repeatedly →
join with `-`**. Testnet tokens are never stripped: `Arbitrum Sepolia → arbitrum-sepolia`,
because aliasing a testnet to its mainnet joins a testnet incident to a mainnet upgrade.
Implementations: `chains-status-news src/upgradeInfo.js` (producer, `networkSlugs` field) and
`chains-api src/domain/networkSlug.js` (consumer). Change one and you must change both.

## Ordering constraint when rolling out

A readiness probe pointing at `/ready` before the image exposing `/ready` is deployed
makes every pod unready — an outage. Sequence: **release the service, let the image
roll out, then change the probe** in the fleet repo.

Similarly, `envFrom.configMapRef` does **not** restart pods, and this fleet has no
config-checksum/Reloader convention, so a ConfigMap-only change needs
`kubectl -n chains-api rollout restart deploy/<service>` to take effect.
