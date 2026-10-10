import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStaticJson } from '../util/staticJson.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dir, '..', '..', 'data', 'forums.json');

function loadRegistry() {
  const parsed = readStaticJson(REGISTRY_PATH, 'Forum registry');
  const forums = Array.isArray(parsed?.forums) ? parsed.forums : [];
  return forums.filter(f => f && typeof f.url === 'string' && Array.isArray(f.chainIds));
}

const FORUMS = loadRegistry();

// chainId -> forum url, first match wins (primary forum per chain)
const BY_CHAIN_ID = new Map();
for (const forum of FORUMS) {
  for (const chainId of forum.chainIds) {
    const id = Number(chainId);
    if (Number.isSafeInteger(id) && !BY_CHAIN_ID.has(id)) {
      BY_CHAIN_ID.set(id, forum.url);
    }
  }
}

/** All forum registry entries. */
export function getAllForums() {
  return FORUMS;
}

/**
 * The forum URL for a chain, or null.
 */
export function getForumByChainId(chainId) {
  return BY_CHAIN_ID.get(Number(chainId)) ?? null;
}

/**
 * Indexer pass: stamp each known chain with a `forumUrl` field.
 * Idempotent — safe to call on every index rebuild.
 */
export function attachForums(indexed) {
  if (!indexed?.byChainId) return;
  for (const [chainId, url] of BY_CHAIN_ID) {
    const chain = indexed.byChainId[chainId];
    if (chain) chain.forumUrl = url;
  }
}
