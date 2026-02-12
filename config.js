// Environment configuration with validation
// All configurable constants are centralized here

function parseIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    console.error(`Invalid value for ${name}: "${raw}" (expected integer). Using default: ${defaultValue}`);
    process.exit(1);
  }
  return parsed;
}

function parseStringEnv(name, defaultValue) {
  return process.env[name] || defaultValue;
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
export const SEARCH_RATE_LIMIT_MAX = parseIntEnv('SEARCH_RATE_LIMIT_MAX', 30);

// RPC health check
export const RPC_CHECK_TIMEOUT_MS = parseIntEnv('RPC_CHECK_TIMEOUT_MS', 8000);
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

// CORS
export const CORS_ORIGIN = parseStringEnv('CORS_ORIGIN', '*');
