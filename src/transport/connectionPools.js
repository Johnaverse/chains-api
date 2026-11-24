/**
 * Keeps the memory held by fetch's connection pools bounded.
 *
 * Node's fetch keeps one connection pool per origin in a process-wide agent. Through Node 22 a
 * pool is never dropped, not even once its last connection has closed, and each one holds about
 * 26 KB. The RPC sweep contacts some 3,400 hosts, so the heap grew by ~125 MB over the first
 * sweep and stayed there, close enough to the limit that the six-hourly registry reload ran the
 * process out of memory.
 *
 * Every FETCH_POOL_MAX_AGE_MS the agent is replaced by a fresh one and the old one closed.
 * Closing is graceful: requests already in flight finish on the old agent; new ones open their
 * connections on the new one.
 */
import { FETCH_POOL_MAX_AGE_MS } from '../../config.js';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';

// Where fetch looks up its agent. Set on the first request, so there is nothing to replace before it.
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

let timer = null;

/**
 * Replace fetch's agent and close the old one. Resolves true when it was replaced. An agent
 * someone configured (a proxy agent, say) is left alone: a fresh one would lose its settings.
 */
export async function recycleConnectionPools() {
  const old = globalThis[GLOBAL_DISPATCHER];
  const Agent = old?.constructor;
  if (!old || Agent?.name !== 'Agent' || typeof old.close !== 'function') return false;
  globalThis[GLOBAL_DISPATCHER] = new Agent();
  incCounter('chains_api_fetch_pool_recycle_total');
  try {
    await old.close();
  } catch (err) {
    logger.warn({ err: err.message || err }, 'Closing the previous fetch agent failed');
  }
  return true;
}

export function startConnectionPoolRecycler() {
  if (timer) return;
  if (!FETCH_POOL_MAX_AGE_MS || FETCH_POOL_MAX_AGE_MS <= 0) {
    logger.info('Fetch connection pools are kept for the life of the process (FETCH_POOL_MAX_AGE_MS=0)');
    return;
  }
  timer = setInterval(() => { recycleConnectionPools().catch(() => {}); }, FETCH_POOL_MAX_AGE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopConnectionPoolRecycler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
