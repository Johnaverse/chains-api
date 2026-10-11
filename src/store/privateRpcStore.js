import { mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_CACHE_ENABLED, DATA_CACHE_FILE } from '../../config.js';
import { logger } from '../util/logger.js';

/**
 * RPC endpoints that answered HTTP 401 (authentication required).
 *
 * A 401 means the URL is a keyed/private endpoint, not a public RPC, so the
 * registry listing it is wrong for our purposes: it is dropped from every
 * chain's served `rpc` list and from rpcHealth, and the refresher never probes
 * it again. The set survives source re-fetches (the indexer rebuilds `rpc` from
 * the registries, so applyDataToCache re-strips it) and restarts (persisted
 * next to the data snapshot as <cache-dir>/rpc-private.json).
 */
const PRIVATE_RPC_FILE = join(dirname(resolve(DATA_CACHE_FILE)), 'rpc-private.json');

const privateUrls = new Set();

function rpcUrlOf(entry) {
  if (typeof entry === 'string') return entry;
  return typeof entry?.url === 'string' ? entry.url : null;
}

export function isPrivateRpc(url) {
  return privateUrls.has(url);
}

export function getPrivateRpcCount() {
  return privateUrls.size;
}

/** Record URLs as private. Returns how many were new; persists when any were. */
export function markPrivateRpcs(urls) {
  let added = 0;
  for (const url of urls) {
    if (typeof url === 'string' && !privateUrls.has(url)) {
      privateUrls.add(url);
      added++;
    }
  }
  if (added > 0) persistPrivateRpcs();
  return added;
}

function stripChain(chain) {
  if (!Array.isArray(chain?.rpc)) return;
  const kept = chain.rpc.filter(entry => !privateUrls.has(rpcUrlOf(entry)));
  if (kept.length !== chain.rpc.length) chain.rpc = kept;
}

/**
 * Remove private URLs from every chain's `rpc` list and from rpcHealth. Both
 * `indexed.all` and `indexed.byChainId` are walked because a snapshot loaded
 * from disk holds them as separate copies.
 */
export function stripPrivateRpcs(indexed, rpcHealth) {
  if (privateUrls.size === 0) return;
  if (indexed) {
    for (const chain of Object.values(indexed.byChainId || {})) stripChain(chain);
    for (const chain of indexed.all || []) stripChain(chain);
  }
  for (const [chainId, results] of Object.entries(rpcHealth || {})) {
    if (!Array.isArray(results)) continue;
    const kept = results.filter(r => !privateUrls.has(r?.url));
    if (kept.length !== results.length) rpcHealth[chainId] = kept;
  }
}

// One writer at a time: a mark that lands mid-write queues exactly one more pass, which
// snapshots the set when it starts — so the last write always holds every URL marked.
let persistInFlight = null;
let persistQueued = false;

function persistPrivateRpcs() {
  if (persistInFlight) {
    persistQueued = true;
    return persistInFlight;
  }
  persistInFlight = (async () => {
    do {
      persistQueued = false;
      await writePrivateRpcs();
    } while (persistQueued);
  })().finally(() => { persistInFlight = null; });
  return persistInFlight;
}

async function writePrivateRpcs() {
  if (!DATA_CACHE_ENABLED) return;
  const tmp = `${PRIVATE_RPC_FILE}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(PRIVATE_RPC_FILE), { recursive: true });
    await writeFile(tmp, JSON.stringify({ urls: [...privateUrls].sort() }), 'utf8');
    await rename(tmp, PRIVATE_RPC_FILE);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    logger.warn({ err: err.message }, 'Failed to persist private RPC list');
  }
}

/** Load the persisted set on startup (merged into anything already marked). */
export async function loadPrivateRpcsFromDisk() {
  if (!DATA_CACHE_ENABLED) return 0;
  try {
    const parsed = JSON.parse(await readFile(PRIVATE_RPC_FILE, 'utf8'));
    for (const url of Array.isArray(parsed?.urls) ? parsed.urls : []) {
      if (typeof url === 'string') privateUrls.add(url);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') logger.warn({ err: err.message }, 'Failed to read private RPC list');
  }
  return privateUrls.size;
}

export function _resetPrivateRpcsForTests() {
  privateUrls.clear();
}
