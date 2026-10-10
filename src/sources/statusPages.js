import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../util/logger.js';
import { readStaticJson } from '../util/staticJson.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dir, '..', '..', 'data', 'status-pages.json');

/**
 * Curated registry of operator status/incident pages, keyed by project.
 * Each entry's `url` applies to every chainId it lists (a single page
 * typically covers a project's mainnet plus its testnets, e.g. Base mainnet
 * and Base Sepolia both point at base-l2.statuspage.io).
 *
 * There is no upstream feed for this data, so the registry is maintained
 * by hand in data/status-pages.json — see CONTRIBUTING notes in that file's
 * PR. Loaded once at module init; the file ships with the image.
 */
function loadRegistry() {
  const parsed = readStaticJson(REGISTRY_PATH, 'Status-page registry');
  const pages = Array.isArray(parsed?.statusPages) ? parsed.statusPages : [];
  const coins = Array.isArray(parsed?.coins) ? parsed.coins : [];
  return {
    statusPages: pages.filter(p => p && typeof p.url === 'string' && Array.isArray(p.chainIds)),
    // coins: symbol-keyed entries for networks not represented as a chainId
    // in our data (non-EVM L1s, protocols) — e.g. Solana, Sui, Aave.
    coins: coins.filter(c => c && typeof c.url === 'string' && typeof c.symbol === 'string')
  };
}

const { statusPages: STATUS_PAGES, coins: COIN_PAGES } = loadRegistry();

// chainId -> { id, name, url } for O(1) lookups during indexing and queries.
const BY_CHAIN_ID = new Map();
for (const page of STATUS_PAGES) {
  for (const chainId of page.chainIds) {
    const id = Number(chainId);
    if (Number.isSafeInteger(id) && !BY_CHAIN_ID.has(id)) {
      BY_CHAIN_ID.set(id, { id: page.id, name: page.name, url: page.url });
    }
  }
}

// SYMBOL -> { symbol, name, url } for coin lookups.
const BY_SYMBOL = new Map();
for (const coin of COIN_PAGES) {
  const sym = coin.symbol.toUpperCase();
  if (!BY_SYMBOL.has(sym)) BY_SYMBOL.set(sym, { symbol: sym, name: coin.name, url: coin.url });
}

/** All chain-keyed registry entries (project id, name, url, chainIds). */
export function getAllStatusPages() {
  return STATUS_PAGES;
}

/** All coin/symbol-keyed entries ({ symbol, name, url }). */
export function getAllCoinStatusPages() {
  return COIN_PAGES;
}

/**
 * The status-page record for a coin symbol, or null. Shape:
 * { symbol, statusPage, name }
 */
export function getStatusPageBySymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const coin = BY_SYMBOL.get(symbol.toUpperCase());
  if (!coin) return null;
  return { symbol: coin.symbol, statusPage: coin.url, name: coin.name };
}

/**
 * The status-page record covering a chain, or null. Shape:
 * { chainId, statusPage, project: { id, name } }
 */
export function getStatusPageByChainId(chainId) {
  const page = BY_CHAIN_ID.get(Number(chainId));
  if (!page) return null;
  return {
    chainId: Number(chainId),
    statusPage: page.url,
    project: { id: page.id, name: page.name }
  };
}

/**
 * Indexer pass: stamp each known chain with a `statusPage` URL. Static data,
 * so this is idempotent and safe to re-run on every index rebuild.
 */
export function attachStatusPages(indexed) {
  if (!indexed?.byChainId) return;
  for (const [chainId, page] of BY_CHAIN_ID) {
    const chain = indexed.byChainId[chainId];
    if (chain) chain.statusPage = page.url;
  }
}
