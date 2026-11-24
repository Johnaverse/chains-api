/**
 * Keeps the memory held by fetch's connection pools bounded.
 *
 * Node's fetch keeps one connection pool per origin in a process-wide agent. Through Node 22 a
 * pool is never dropped, not even once its last connection has closed, and each one holds about
 * 26 KB. The RPC sweep contacts some 3,400 hosts, so the heap grew by ~125 MB over the first
 * sweep and stayed there, close enough to the limit that the six-hourly registry reload ran the
 * process out of memory.
 *
 * Every FETCH_POOL_MAX_AGE_MS the agent is replaced by a fresh one. The replaced agent stays open
 * for one more interval and is closed at the next replacement: a fetch keeps the agent it started
 * with for its whole life, redirects included, so a hop that arrives after the swap still has a
 * working agent. Closing is graceful as well: whatever is still in flight then finishes first.
 */
import { FETCH_POOL_MAX_AGE_MS } from '../../config.js';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';

// Where fetch looks up its agent. Set on the first request, so there is nothing to replace before it.
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

let timer = null;
// The agent replaced last time, still serving the fetches that started on it.
let retired = null;

async function close(agent) {
  try {
    await agent.close();
  } catch (err) {
    logger.warn({ err: err.message || err }, 'Closing a replaced fetch agent failed');
  }
}

/**
 * Replace fetch's agent, and close the one replaced the time before. Resolves true when it was
 * replaced. An agent someone configured (a proxy agent, say) is left alone: a fresh one would
 * lose its settings.
 */
export async function recycleConnectionPools() {
  const old = globalThis[GLOBAL_DISPATCHER];
  const Agent = old?.constructor;
  if (!old || Agent?.name !== 'Agent' || typeof old.close !== 'function') return false;
  globalThis[GLOBAL_DISPATCHER] = new Agent();
  incCounter('chains_api_fetch_pool_recycle_total');
  const expired = retired;
  retired = old;
  if (expired) await close(expired);
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

/** Stop replacing. The agent retired last is closed now; the current one stays in use. */
export function stopConnectionPoolRecycler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const expired = retired;
  retired = null;
  if (expired) close(expired);
}

/** Forget the retired agent without closing it. */
export function _resetConnectionPoolsForTests() {
  retired = null;
  stopConnectionPoolRecycler();
}
