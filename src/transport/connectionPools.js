/**
 * Keeps the memory held by fetch's connection pools bounded.
 *
 * Node's fetch keeps one connection pool per origin in a process-wide agent. Through Node 22 a
 * pool is never dropped, not even once its last connection has closed, and each one holds about
 * 26 KB. The RPC sweep contacts some 3,400 hosts, so the heap grew by ~125 MB over the first
 * sweep and stayed there, close enough to the limit that the six-hourly registry reload ran the
 * process out of memory.
 *
 * Every FETCH_POOL_MAX_AGE_MS the agent is replaced by a fresh one. A replaced agent goes through
 * three rounds: it stays open for one, because a fetch keeps the agent it started with for its
 * whole life and a redirect hop that arrives after the swap needs a working agent; it is closed
 * gracefully at the next, so whatever is still in flight finishes first; and it is destroyed at
 * the one after, so a response nobody finished reading cannot keep it, and its pools, forever.
 * The interval is never shorter than MIN_AGE_MS, which keeps those rounds longer than any
 * request this service makes with a redirect in it.
 */
import { FETCH_POOL_MAX_AGE_MS } from '../../config.js';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';

// Where fetch looks up its agent. Set on the first request, so there is nothing to replace before it.
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

const MIN_AGE_MS = 60_000;

let timer = null;
// The agent replaced last time, still open for the fetches that started on it.
let retired = null;
// The agent replaced the time before, closing as its last requests finish.
let closing = null;

function shut(agent, how) {
  if (!agent) return;
  Promise.resolve()
    .then(() => agent[how]())
    .catch((err) => logger.warn({ err: err.message || err }, 'Closing a replaced fetch agent failed'));
}

/**
 * Replace fetch's agent and move the earlier ones a round on (see above). Resolves true when it
 * was replaced. An agent someone configured (a proxy agent, say) is left alone: a fresh one
 * would lose its settings.
 */
export async function recycleConnectionPools() {
  const old = globalThis[GLOBAL_DISPATCHER];
  const Agent = old?.constructor;
  if (!old || Agent?.name !== 'Agent' || typeof old.close !== 'function') return false;
  globalThis[GLOBAL_DISPATCHER] = new Agent();
  incCounter('chains_api_fetch_pool_recycle_total');
  shut(closing, 'destroy');
  closing = retired;
  shut(closing, 'close');
  retired = old;
  return true;
}

export function startConnectionPoolRecycler() {
  if (timer) return;
  if (!FETCH_POOL_MAX_AGE_MS || FETCH_POOL_MAX_AGE_MS <= 0) {
    logger.info('Fetch connection pools are kept for the life of the process (FETCH_POOL_MAX_AGE_MS=0)');
    return;
  }
  timer = setInterval(() => { recycleConnectionPools().catch(() => {}); }, Math.max(FETCH_POOL_MAX_AGE_MS, MIN_AGE_MS));
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop replacing. The agents already replaced are closed now; the current one stays in use. */
export function stopConnectionPoolRecycler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  shut(closing, 'destroy');
  shut(retired, 'close');
  closing = null;
  retired = null;
}

/** Forget the replaced agents without closing them. */
export function _resetConnectionPoolsForTests() {
  closing = null;
  retired = null;
  stopConnectionPoolRecycler();
}
