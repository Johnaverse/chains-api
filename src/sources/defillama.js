import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_SOURCE_DEFILLAMA_CONFIG, DEFILLAMA_FETCH_TIMEOUT_MS } from '../../config.js';
import { proxyFetch } from '../../fetchUtil.js';
import { logger } from '../util/logger.js';
import { safeExternalUrl } from '../util/publicHost.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = join(__dir, '..', '..', 'data', 'defillama-fallback.json');

const TWITTER_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const GITHUB_ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * Static chain metadata from DefiLlama's keyless `/config` endpoint: official
 * website, X/Twitter handle, GitHub orgs, native/gas token ids (CoinGecko, CMC),
 * categories and parent chain. Falls back to a checked-in snapshot when the
 * live endpoint is unreachable, the same contract as L2BEAT.
 *
 * Returns: { source: 'live'|'fallback'|'unavailable', fetchedAt, chains: [] }
 */
export async function fetchDefiLlama() {
  const live = await fetchLive();
  if (live) return live;
  return loadFallback();
}

async function fetchLive() {
  try {
    const response = await proxyFetch(DATA_SOURCE_DEFILLAMA_CONFIG, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DEFILLAMA_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'DefiLlama live fetch failed; falling back to static snapshot');
      return null;
    }
    const chains = normalizeDefiLlamaConfig(await response.json());
    if (chains.length === 0) {
      logger.warn('DefiLlama live fetch returned 0 usable chains; falling back to static snapshot');
      return null;
    }
    return { source: 'live', fetchedAt: new Date().toISOString(), chains };
  } catch (err) {
    logger.warn({ reason: err.message }, 'DefiLlama live fetch failed; falling back to static snapshot');
    return null;
  }
}

async function loadFallback() {
  try {
    const data = JSON.parse(await readFile(FALLBACK_PATH, 'utf8'));
    const chains = Array.isArray(data?.chains) ? data.chains : [];
    return { source: 'fallback', fetchedAt: data?.fetchedAt ?? null, chains };
  } catch (err) {
    logger.warn({ err: err.message }, 'DefiLlama fallback unavailable');
    return { source: 'unavailable', fetchedAt: null, chains: [] };
  }
}

/**
 * Reduce DefiLlama's `chainCoingeckoIds` map to one entry per EVM chainId.
 * DefiLlama keeps renamed chains under both labels ("Optimism" and
 * "OP Mainnet", "Binance" and "BSC") with identical data, so the first live
 * label wins and the rest become `aliases`. Entries without a chainId are
 * dropped: the index is keyed by chainId and has nowhere to attach them.
 */
export function normalizeDefiLlamaConfig(json) {
  const raw = json?.chainCoingeckoIds;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const byChainId = new Map();
  for (const [label, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue;
    const chainId = coerceChainId(entry.chainId ?? entry.chainid);
    if (chainId === null) continue;

    const normalized = normalizeEntry(label, chainId, entry);
    const existing = byChainId.get(chainId);
    if (!existing) {
      byChainId.set(chainId, normalized);
    } else if (existing.deprecated && !normalized.deprecated) {
      byChainId.set(chainId, { ...normalized, aliases: [existing.name, ...existing.aliases] });
    } else {
      existing.aliases.push(label);
    }
  }
  return [...byChainId.values()];
}

function normalizeEntry(label, chainId, entry) {
  return {
    chainId,
    name: label,
    aliases: [],
    website: safeExternalUrl(entry.url)?.href ?? null,
    twitter: cleanHandle(entry.twitter),
    github: Array.isArray(entry.github) ? entry.github.filter(g => typeof g === 'string' && GITHUB_ORG.test(g)) : [],
    symbol: stringOrNull(entry.symbol),
    gasTokenSymbol: stringOrNull(entry.gasTokenSymbol),
    geckoId: stringOrNull(entry.geckoId),
    gasTokenGeckoId: stringOrNull(entry.gasTokenGeckoId),
    cmcId: entry.cmcId == null ? null : String(entry.cmcId),
    categories: Array.isArray(entry.categories) ? entry.categories.filter(c => typeof c === 'string') : [],
    parent: normalizeParent(entry.parent),
    deprecated: entry.deprecated === true,
    deadFrom: stringOrNull(entry.deadFrom)
  };
}

function normalizeParent(parent) {
  if (!parent || typeof parent.chain !== 'string') return null;
  return {
    chain: parent.chain,
    types: Array.isArray(parent.types) ? parent.types.filter(t => typeof t === 'string') : [],
    da: stringOrNull(parent.da)
  };
}

function cleanHandle(value) {
  if (typeof value !== 'string') return null;
  const handle = value.trim().replace(/^@/, '');
  return TWITTER_HANDLE.test(handle) ? handle : null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function coerceChainId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}
