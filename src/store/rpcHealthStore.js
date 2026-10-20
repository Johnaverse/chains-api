import { mkdir, writeFile, rename, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DATA_CACHE_ENABLED, DATA_CACHE_FILE } from '../../config.js';
import { logger } from '../util/logger.js';

/**
 * Per-chain RPC-health persistence.
 *
 * The rolling refresher tests one chain's endpoints at a time. Rather than
 * rewriting one big state blob on a timer, each chain's status is written to
 * its own small file *the moment its up/down state changes* — so the on-disk
 * cache updates live, incrementally, one chain at a time, and a restart
 * resumes from the last known per-endpoint status.
 *
 * Stored next to the data snapshot: <cache-dir>/rpc-health/<chainId>.json
 */
const RPC_HEALTH_DIR = join(dirname(resolve(DATA_CACHE_FILE)), 'rpc-health');

/**
 * True when the up/down state of a chain's endpoints differs from `prev`.
 * Deliberately ignores volatile fields (blockHeight, latency, clientVersion):
 * only a change in the set of URLs or any endpoint's ok/failed status, failure kind or failing-since time counts,
 * so a healthy endpoint advancing its block height does NOT trigger a write.
 */
export function rpcStateChanged(prev, next) {
  if (!Array.isArray(prev)) return true;
  if (prev.length !== next.length) return true;
  // `failure` and `failingSince` count too: how and since when an endpoint is down is what
  // validation reads (rule 18). failingSince only changes when an endpoint goes down.
  const state = (r) => `${r.ok === true}|${r.failure ?? ''}|${r.failingSince ?? ''}`;
  const prevByUrl = new Map(prev.map(r => [r.url, state(r)]));
  for (const r of next) {
    if (!prevByUrl.has(r.url)) return true;
    if (prevByUrl.get(r.url) !== state(r)) return true;
  }
  return false;
}

/** Atomically persist one chain's endpoint statuses. Best-effort. */
export async function persistChainRpcHealth(chainId, results) {
  if (!DATA_CACHE_ENABLED) return;
  const file = join(RPC_HEALTH_DIR, `${chainId}.json`);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify({
    chainId: Number(chainId),
    checkedAt: new Date().toISOString(),
    results
  });
  try {
    await mkdir(RPC_HEALTH_DIR, { recursive: true });
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    try { await rm(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    logger.warn({ chainId, err: err.message }, 'Failed to persist RPC-health state');
  }
}

/**
 * Load every persisted chain's RPC health on startup.
 * Returns { byChainId: { [chainId]: results[] }, lastCheckedAt }.
 */
export async function loadAllRpcHealthFromDisk() {
  const empty = { byChainId: {}, lastCheckedAt: null };
  if (!DATA_CACHE_ENABLED) return empty;

  let files;
  try {
    files = await readdir(RPC_HEALTH_DIR);
  } catch (err) {
    if (err?.code === 'ENOENT') return empty;
    logger.warn({ err: err.message }, 'Failed to list RPC-health cache');
    return empty;
  }

  // Read concurrently — this runs on the startup path before the server is
  // ready, so a sequential loop over thousands of chains would add seconds of
  // boot latency. Array order is preserved for a deterministic merge.
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  const parsedEntries = await Promise.all(jsonFiles.map(async (f) => {
    try {
      const parsed = JSON.parse(await readFile(join(RPC_HEALTH_DIR, f), 'utf8'));
      if (parsed && Number.isFinite(parsed.chainId) && Array.isArray(parsed.results)) {
        return parsed;
      }
    } catch { /* skip unreadable/corrupt entry */ }
    return null;
  }));

  const byChainId = {};
  let lastCheckedAt = null;
  for (const parsed of parsedEntries) {
    if (!parsed) continue;
    byChainId[parsed.chainId] = parsed.results;
    if (parsed.checkedAt && (!lastCheckedAt || parsed.checkedAt > lastCheckedAt)) {
      lastCheckedAt = parsed.checkedAt;
    }
  }
  return { byChainId, lastCheckedAt };
}
