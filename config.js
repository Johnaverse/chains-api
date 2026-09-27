// Environment configuration with validation
// All configurable constants are centralized here

import { dirname, join } from 'node:path';

function parseIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid value for ${name}: "${raw}" (expected integer). Using default: ${defaultValue}`);
    process.exit(1);
  }
  return parsed;
}

function parseStringEnv(name, defaultValue) {
  return process.env[name] || defaultValue;
}

function parseBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  console.error(`Invalid value for ${name}: "${raw}" (expected boolean). Using default: ${defaultValue}`);
  process.exit(1);
}

// Server
export const PORT = parseIntEnv('PORT', 3000);
export const HOST = parseStringEnv('HOST', '0.0.0.0');
export const MCP_PORT = parseIntEnv('MCP_PORT', 3001);
export const MCP_HOST = parseStringEnv('MCP_HOST', '0.0.0.0');

// Request limits
export const BODY_LIMIT = parseIntEnv('BODY_LIMIT', 1048576); // 1 MB
export const MAX_PARAM_LENGTH = parseIntEnv('MAX_PARAM_LENGTH', 200);

// Rate limiting
export const RATE_LIMIT_MAX = parseIntEnv('RATE_LIMIT_MAX', 100);
export const RATE_LIMIT_WINDOW_MS = parseIntEnv('RATE_LIMIT_WINDOW_MS', 60000); // 1 minute
export const RELOAD_RATE_LIMIT_MAX = parseIntEnv('RELOAD_RATE_LIMIT_MAX', 5);
export const FEEDBACK_RATE_LIMIT_MAX = parseIntEnv('FEEDBACK_RATE_LIMIT_MAX', 5);
export const SEARCH_RATE_LIMIT_MAX = parseIntEnv('SEARCH_RATE_LIMIT_MAX', 30);

// RPC health check
export const RPC_CHECK_TIMEOUT_MS = parseIntEnv('RPC_CHECK_TIMEOUT_MS', 8000);
/**
 * @deprecated Unused since the unified rolling refresher (services/chainRefresher.js).
 * The new loop processes one chain per tick; each chain's RPC endpoints are
 * checked in parallel inside that chain's job. There is no global concurrency
 * cap. Kept for backwards-compatible env parsing; safe to remove in v2.
 */
export const RPC_CHECK_CONCURRENCY = parseIntEnv('RPC_CHECK_CONCURRENCY', 8);
export const MAX_ENDPOINTS_PER_CHAIN = parseIntEnv('MAX_ENDPOINTS_PER_CHAIN', 5);

// Search
export const MAX_SEARCH_QUERY_LENGTH = parseIntEnv('MAX_SEARCH_QUERY_LENGTH', 200);

// Data source URLs
export const DATA_SOURCE_THE_GRAPH = parseStringEnv(
  'DATA_SOURCE_THE_GRAPH',
  'https://raw.githubusercontent.com/Johnaverse/networks-registry/refs/heads/main/public/TheGraphNetworksRegistry.json'
);
export const DATA_SOURCE_CHAINLIST = parseStringEnv(
  'DATA_SOURCE_CHAINLIST',
  'https://chainlist.org/rpcs.json'
);
export const DATA_SOURCE_CHAINS = parseStringEnv(
  'DATA_SOURCE_CHAINS',
  'https://chainid.network/chains.json'
);
export const DATA_SOURCE_SLIP44 = parseStringEnv(
  'DATA_SOURCE_SLIP44',
  'https://raw.githubusercontent.com/satoshilabs/slips/master/slip-0044.md'
);
export const DATA_SOURCE_L2BEAT_API = parseStringEnv(
  'DATA_SOURCE_L2BEAT_API',
  'https://l2beat.com/api/scaling/summary'
);
export const L2BEAT_FETCH_TIMEOUT_MS = parseIntEnv('L2BEAT_FETCH_TIMEOUT_MS', 10000);

// How long L2BEAT data may go without a successful refresh before /health
// flags it stale. L2BEAT refreshes once per full rolling sweep
// (CHAIN_REFRESHER_TICK_MS × chain count ≈ tens of minutes for ~3k chains),
// so this bound must be generous — a tight value (e.g. the old 2× refresh
// interval) reads as permanently "degraded" even though the refresher is
// healthy. Default 6h catches a genuinely stuck refresher without false alarms.
export const L2BEAT_STALE_AFTER_MS = parseIntEnv('L2BEAT_STALE_AFTER_MS', 6 * 60 * 60 * 1000);

// Source fetch resilience. A source fetch is retried with exponential backoff
// before being treated as failed, so a transient blip at startup doesn't leave
// a registry permanently empty until a manual reload.
export const SOURCE_FETCH_MAX_RETRIES = parseIntEnv('SOURCE_FETCH_MAX_RETRIES', 3);
export const SOURCE_FETCH_RETRY_BASE_MS = parseIntEnv('SOURCE_FETCH_RETRY_BASE_MS', 500);
// Background self-heal: every interval, if any core/supplementary source is
// currently missing (e.g. failed at boot), re-fetch all sources. Set to 0 to
// disable. Default 15 min.
export const SOURCE_REFRESH_INTERVAL_MS = parseIntEnv('SOURCE_REFRESH_INTERVAL_MS', 900000);
/**
 * @deprecated Cadence is now driven by the unified rolling refresher
 * (CHAIN_REFRESHER_TICK_MS × queue length). Kept so /scaling/status can keep
 * exposing the value as a hint to consumers, but no longer used for
 * scheduling. Safe to remove in v2 once consumers migrate to /refresher.
 */
export const L2BEAT_REFRESH_INTERVAL_MS = parseIntEnv('L2BEAT_REFRESH_INTERVAL_MS', 300000);

// Disk cache
export const DATA_CACHE_ENABLED = parseBooleanEnv('DATA_CACHE_ENABLED', true);
export const DATA_CACHE_FILE = parseStringEnv('DATA_CACHE_FILE', '.cache/chains-api-data.json');

// CORS
export const CORS_ORIGIN = parseStringEnv('CORS_ORIGIN', '*');

// Accounts: email sign-in (magic link + code), optional salted password, password reset.
//
// Closed by default, in the spirit of SERVICE-CONTRACT §10: until all three of the allowlist,
// the app URL and an SMTP host are set, no /auth route is registered at all and every
// endpoint answers 404. There is no half-configured mode that could email a sign-in link
// pointing nowhere, or accept sign-ups from anyone.
//
// Comma-separated. `alice@example.com` allows one address; `@example.com` allows a domain.
// Only these can ever receive mail from the sign-in form, which also means an attacker cannot
// use it to send our mail to arbitrary inboxes.
export const AUTH_ALLOWED_EMAILS = parseStringEnv('AUTH_ALLOWED_EMAILS', '');
// Base URL of the dashboard the links in sign-in emails open, e.g.
// https://www.johnaverse.cc/chains-api/ — links go to `${AUTH_APP_URL}login.html#…`.
export const AUTH_APP_URL = parseStringEnv('AUTH_APP_URL', '');
// Extra browser origins allowed to make credentialed auth calls (comma-separated). The
// origin of AUTH_APP_URL is always allowed; this is for a second dashboard host.
export const AUTH_ALLOWED_ORIGINS = parseStringEnv('AUTH_ALLOWED_ORIGINS', '');
// Accounts and hashed session tokens. Defaults beside the data cache, like feedback.jsonl.
export const AUTH_STORE_FILE = parseStringEnv(
  'AUTH_STORE_FILE',
  join(dirname(DATA_CACHE_FILE), 'auth.json')
);
export const AUTH_SESSION_TTL_DAYS = parseIntEnv('AUTH_SESSION_TTL_DAYS', 30);
// Off only for plain-http local development; browsers drop Secure cookies over http.
export const AUTH_COOKIE_SECURE = parseBooleanEnv('AUTH_COOKIE_SECURE', true);
// Per-IP budget on the sign-in, code and reset endpoints, per RATE_LIMIT_WINDOW_MS.
export const AUTH_RATE_LIMIT_MAX = parseIntEnv('AUTH_RATE_LIMIT_MAX', 10);

// Outbound mail for sign-in and reset. Port 587 uses STARTTLS, which is REQUIRED — a server
// that does not offer it fails the send rather than carrying codes in cleartext. Set
// SMTP_SECURE=true for implicit TLS on 465. SMTP_PASS is never logged.
export const SMTP_HOST = parseStringEnv('SMTP_HOST', '');
export const SMTP_PORT = parseIntEnv('SMTP_PORT', 587);
export const SMTP_SECURE = parseBooleanEnv('SMTP_SECURE', false);
export const SMTP_USER = parseStringEnv('SMTP_USER', '');
export const SMTP_PASS = parseStringEnv('SMTP_PASS', '');
export const SMTP_FROM = parseStringEnv('SMTP_FROM', 'Chains <no-reply@localhost>');

export const AUTH_ENABLED = AUTH_ALLOWED_EMAILS !== '' && AUTH_APP_URL !== '' && SMTP_HOST !== '';

// Proxy (optional)
export const PROXY_URL = parseStringEnv('PROXY_URL', '');
export const PROXY_ENABLED = PROXY_URL !== '';

// Price cache
export const PRICE_CACHE_TTL_MS = parseIntEnv('PRICE_CACHE_TTL_MS', 3600000);
export const PRICE_NEGATIVE_CACHE_TTL_MS = parseIntEnv('PRICE_NEGATIVE_CACHE_TTL_MS', 300000);
export const PRICE_FETCH_TIMEOUT_MS = parseIntEnv('PRICE_FETCH_TIMEOUT_MS', 3000);
// How old COINGECKO'S OWN `last_updated_at` may be before a quote stops counting as current.
//
// Named for the quote rather than for staleness because three different durations meet here
// and only one of them is about us:
//   • the "24h" in 24h volume is CoinGecko's measurement WINDOW, which rolls continuously
//     upstream and is not a refresh interval at all;
//   • PRICE_CACHE_TTL_MS is how often WE re-read the number;
//   • this is how stale the UPSTREAM number may be before we refuse to call it current.
// The last two both defaulting to a day's magnitude was needlessly confusing.
//
// CoinGecko keeps serving quotes for assets whose market has moved on (observed 183 days for
// matic-network, 274 for the since-delisted oec-token), so without this a long-dead number is
// indistinguishable from a live one. A day is deliberately generous — a real market moves
// within minutes — because the job is to catch the dead, not the merely quiet.
export const PRICE_QUOTE_MAX_AGE_MS = parseIntEnv('PRICE_QUOTE_MAX_AGE_MS', 86400000);

// How often to re-warm every mapped asset in the background. Without this, prices refresh
// only when a request happens to find an expired entry, which makes one unlucky caller per
// hour wait on a CoinGecko round trip. One batched request per tick — ~32 calls a day against
// a free tier that allows tens per minute. 0 disables it and restores purely lazy refresh.
//
// Deliberately SHORTER than PRICE_CACHE_TTL_MS. Setting the two equal, as the first cut did,
// means the cache expires at the same instant the refresher fires — so a request landing in
// that gap still pays the round trip, which is the one thing this timer exists to prevent.
// Re-warming at 45 minutes keeps an hour-long entry continuously warm.
export const PRICE_REFRESH_INTERVAL_MS = parseIntEnv('PRICE_REFRESH_INTERVAL_MS', 2700000);

// Blockscout explorer (keyless). Used as an independent, non-RPC witness for
// the chain-halt check: a chain's own RPC endpoints can agree with each other
// and still all be wrong, so a second opinion from a different stack matters.
// Per-instance endpoints (eth.blockscout.com/api/v2) need no API key and cap
// at 10 rps per IP — the whole pod shares one IP, hence MAX_RPS well under it.
export const BLOCKSCOUT_ENABLED = parseBooleanEnv('BLOCKSCOUT_ENABLED', true);
// Liveness data: a short TTL absorbs repeat questions without serving stale
// heights into a halt verdict.
export const BLOCKSCOUT_CACHE_TTL_MS = parseIntEnv('BLOCKSCOUT_CACHE_TTL_MS', 15000);
// Which instance serves a chain changes on the order of never, and ~2200 of
// the ~2700 registry chains have none — so resolution (including the negative
// result) is cached for hours to keep them from being re-probed per question.
export const BLOCKSCOUT_INSTANCE_CACHE_TTL_MS = parseIntEnv('BLOCKSCOUT_INSTANCE_CACHE_TTL_MS', 21600000);
export const BLOCKSCOUT_FETCH_TIMEOUT_MS = parseIntEnv('BLOCKSCOUT_FETCH_TIMEOUT_MS', 4000);
export const BLOCKSCOUT_MAX_RPS = parseIntEnv('BLOCKSCOUT_MAX_RPS', 5);

// Chain-halt check. Probes a chain's public RPC endpoints live (plus the
// explorer above) and decides whether the chain itself has stopped producing
// blocks, as opposed to a single endpoint falling behind.
export const HALT_CHECK_MAX_ENDPOINTS = parseIntEnv('HALT_CHECK_MAX_ENDPOINTS', 8);
export const HALT_CHECK_TIMEOUT_MS = parseIntEnv('HALT_CHECK_TIMEOUT_MS', 5000);
// A block is "overdue" once it is older than MULTIPLIER x the chain's average
// block time. MIN_SECONDS is a floor, not a nicety: on a 2s-block chain a bare
// multiple would call a halt after six seconds of ordinary jitter.
export const HALT_BLOCK_TIME_MULTIPLIER = parseIntEnv('HALT_BLOCK_TIME_MULTIPLIER', 3);
export const HALT_MIN_SECONDS = parseIntEnv('HALT_MIN_SECONDS', 90);

// Live incidents feed (chains-status-news). Used by the get_live_incidents
// tool so the assistant/MCP can answer "is X down" questions server-side.
export const LIVE_INCIDENTS_URL = parseStringEnv(
  'LIVE_INCIDENTS_URL',
  'https://chains-status-news.johnaverse.cc'
);
export const LIVE_INCIDENTS_CACHE_TTL_MS = parseIntEnv('LIVE_INCIDENTS_CACHE_TTL_MS', 60000);
export const LIVE_INCIDENTS_FETCH_TIMEOUT_MS = parseIntEnv('LIVE_INCIDENTS_FETCH_TIMEOUT_MS', 10000);

// Forum/governance news feed (chains-forum-news). Used by the get_forum_news
// tool so the assistant/MCP can answer governance-discussion questions.
export const FORUM_NEWS_URL = parseStringEnv(
  'FORUM_NEWS_URL',
  'https://chains-forum-news.johnaverse.cc'
);
// Ecosystem/editorial news feed (chains-news). Cluster DNS in deployment; the public host
// is only a local-dev convenience — see docs/SERVICE-CONTRACT.md rule 1 on why an unset
// var must not silently leave the cluster.
export const WEB3_NEWS_URL = parseStringEnv(
  'WEB3_NEWS_URL',
  'https://chains-news.johnaverse.cc'
);
export const WEB3_NEWS_CACHE_TTL_MS = parseIntEnv('WEB3_NEWS_CACHE_TTL_MS', 60000);
export const WEB3_NEWS_FETCH_TIMEOUT_MS = parseIntEnv('WEB3_NEWS_FETCH_TIMEOUT_MS', 10000);

export const FORUM_NEWS_CACHE_TTL_MS = parseIntEnv('FORUM_NEWS_CACHE_TTL_MS', 60000);
export const FORUM_NEWS_FETCH_TIMEOUT_MS = parseIntEnv('FORUM_NEWS_FETCH_TIMEOUT_MS', 10000);

// Assistant (optional LLM chat over the registry + live incidents).
// Disabled unless ASSISTANT_LLM_URL points at an OpenAI-compatible server
// (e.g. Ollama: http://localhost:11434).
export const ASSISTANT_LLM_URL = parseStringEnv('ASSISTANT_LLM_URL', '');
export const ASSISTANT_ENABLED = ASSISTANT_LLM_URL !== '';
// Optional bearer token for key-protected OpenAI-compatible servers
// (OpenAI, OpenRouter, Groq, or an auth-fronted Ollama). Never logged or
// exposed via any endpoint.
export const ASSISTANT_LLM_API_KEY = parseStringEnv('ASSISTANT_LLM_API_KEY', '');
export const ASSISTANT_MODEL = parseStringEnv('ASSISTANT_MODEL', 'qwen3');
// Optional fallback provider: when the primary LLM fails a call, the run
// switches here (sticky for the rest of that run). Any OpenAI-compatible
// server — e.g. a smaller local model, or a hosted API with a key.
export const ASSISTANT_FALLBACK_LLM_URL = parseStringEnv('ASSISTANT_FALLBACK_LLM_URL', '');
export const ASSISTANT_FALLBACK_LLM_API_KEY = parseStringEnv('ASSISTANT_FALLBACK_LLM_API_KEY', '');
export const ASSISTANT_FALLBACK_MODEL = parseStringEnv('ASSISTANT_FALLBACK_MODEL', '');
export const ASSISTANT_MAX_TOOL_ITERATIONS = parseIntEnv('ASSISTANT_MAX_TOOL_ITERATIONS', 6);
export const ASSISTANT_TIMEOUT_MS = parseIntEnv('ASSISTANT_TIMEOUT_MS', 60000);
export const ASSISTANT_MAX_TOKENS = parseIntEnv('ASSISTANT_MAX_TOKENS', 1024);
export const ASSISTANT_RATE_LIMIT_MAX = parseIntEnv('ASSISTANT_RATE_LIMIT_MAX', 10);
export const ASSISTANT_MAX_MESSAGES = parseIntEnv('ASSISTANT_MAX_MESSAGES', 20);
export const ASSISTANT_MAX_MESSAGE_LENGTH = parseIntEnv('ASSISTANT_MAX_MESSAGE_LENGTH', 4000);
export const ASSISTANT_TOOL_RESULT_MAX_CHARS = parseIntEnv('ASSISTANT_TOOL_RESULT_MAX_CHARS', 8000);
// Async job handling: slow local models exceed reverse-proxy timeouts
// (observed 15s ingress 504s), so POST /assistant/chat waits at most
// SYNC_WAIT for the answer and otherwise returns 202 + a job id the client
// polls. Finished jobs are kept for JOB_TTL; at most MAX_CONCURRENT_JOBS
// LLM runs are in flight at once.
// Pre-classification topic guard: a cheap extra LLM call that rejects
// off-topic questions before the (expensive) tool loop runs. Fails open —
// classifier trouble never blocks on-topic questions.
export const ASSISTANT_TOPIC_GUARD = parseBooleanEnv('ASSISTANT_TOPIC_GUARD', true);
export const ASSISTANT_SYNC_WAIT_MS = parseIntEnv('ASSISTANT_SYNC_WAIT_MS', 8000);
export const ASSISTANT_JOB_TTL_MS = parseIntEnv('ASSISTANT_JOB_TTL_MS', 600000);
export const ASSISTANT_MAX_CONCURRENT_JOBS = parseIntEnv('ASSISTANT_MAX_CONCURRENT_JOBS', 4);
