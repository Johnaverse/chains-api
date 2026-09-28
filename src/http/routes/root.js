import pkg from '../../../package.json' with { type: 'json' };
import {
  DATA_SOURCE_THE_GRAPH,
  DATA_SOURCE_CHAINLIST,
  DATA_SOURCE_CHAINS,
  DATA_SOURCE_SLIP44,
  DATA_SOURCE_L2BEAT_API
} from '../../../config.js';

const ENDPOINTS = {
  '/health': 'Health check and data status (liveness; always 200 while the process is up)',
  '/ready': 'Readiness probe (503 until the first data load completes)',
  '/chains': 'Get all chains (optional ?tag=Testnet|L2|Beacon)',
  '/chains/:id': 'Get chain by ID',
  '/search?q={query}': 'Search chains by name or ID',
  '/relations': 'Get all chain relations data',
  '/relations/:id': 'Get relations for a specific chain by ID',
  '/endpoints': 'Get all chain endpoints (RPC, firehose, substreams)',
  '/endpoints/:id': 'Get endpoints for a specific chain by ID',
  '/sources': 'Get data sources status',
  '/export': 'Export cached snapshot file',
  '/slip44': 'Get all SLIP-0044 coin types as JSON',
  '/slip44/:coinType': 'Get specific SLIP-0044 coin type by ID',
  '/reload': 'Reload data from sources (POST)',
  '/validate': 'Validate chain data for potential human errors',
  '/keywords': 'Get extracted keywords (blockchain names, network names, client names, etc.)',
  '/rpc-monitor': 'Get RPC endpoint monitoring results',
  '/rpc-monitor/:id': 'Get RPC monitoring results for a specific chain by ID',
  '/stats': 'Get aggregate stats (chain counts, RPC health percentage)',
  '/upgrades': 'Cross-feed upgrade timeline: scheduled upgrades with required software, urgency, follow-on incidents, and forum/news context',
  '/forks': 'Forks as entities: one per fork per network, with every provider window attached, activation evidence and lifecycle phase (?chainId, ?phase, ?scheduledOnly)',
  '/providers/stats': 'Per-RPC-provider quality indicators: incidents/resolution/availability derived from the provider\'s own status page (self-reported), plus registry-endpoint reachability (optional ?provider=)',
  '/auth/login/start': 'Start signing in (POST {email, password?}): emails a magic link and a 6-digit code. Only when accounts are configured',
  '/auth/login/verify': 'Finish signing in with the code (POST {attemptId, code})',
  '/auth/login/link': 'Finish signing in with the magic-link token (POST {token})',
  '/auth/session': 'Who is signed in (always 200)',
  '/auth/logout': 'Sign out this browser (POST)',
  '/auth/password': 'Set or change the password of the signed-in account (POST)',
  '/auth/password/reset/start': 'Email a password-reset link and code (POST {email})',
  '/auth/password/reset/complete': 'Choose a new password with the reset code or link (POST)',
  '/admin/conflicts': 'Admin: the cross-source conflict review queue with counts, evidence and decisions (session required; only when accounts are configured)',
  '/admin/conflicts/:id/review': 'Admin: acknowledge, dismiss (reason required) or reopen a conflict (POST)',
  '/admin/conflicts/prune-resolved': 'Admin: clear decisions whose conflict no longer occurs (POST)',
  '/admin/conflicts/history': 'Admin: audit trail of every decision, newest first',
  '/feedback': 'Report wrong or misattributed info (POST) / review submitted reports newest-first (GET ?kind=&limit=)',
  '/summary': 'Slim dashboard projection: all chains (id, name, tags, relations, RPC count) + L2BEAT headline data, with ETag revalidation',
  '/relations/:id/graph?depth=N': 'BFS graph traversal of chain relations (default depth: 2)',
  '/scaling': 'Get all chains with L2BEAT scaling data (stage, category, DA layer, TVS)',
  '/scaling/:id': 'Get L2BEAT scaling data for a specific chain by ID',
  '/scaling/status': 'Get L2BEAT refresher status (last refresh, source, errors)',
  '/metrics': 'Prometheus exposition format (counters + gauges for source freshness, refreshes, validation)',
  '/refresher': 'Unified rolling refresher status (queue depth, sweep cursor, per-job-type state)',
  '/assistant': 'Assistant availability probe (enabled flag + model)',
  '/assistant/chat': 'Chat with the LLM assistant about chains, endpoints, scaling, and live incidents (POST)',
  '/docs': 'Interactive API reference (Swagger UI)',
  '/openapi.json': 'OpenAPI 3 specification (machine-readable)'
};

export async function rootRoute(fastify) {
  fastify.get('/', async () => ({
    name: 'Chains API',
    version: pkg.version,
    description: 'API query service for blockchain chain data from multiple sources',
    endpoints: ENDPOINTS,
    dataSources: [
      DATA_SOURCE_THE_GRAPH,
      DATA_SOURCE_CHAINLIST,
      DATA_SOURCE_CHAINS,
      DATA_SOURCE_SLIP44,
      DATA_SOURCE_L2BEAT_API
    ]
  }));
}
