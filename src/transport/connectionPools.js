/**
 * Keeps the memory held by fetch's connection pools bounded.
 *
 * Node's fetch keeps one connection pool per origin in a process-wide agent. Through Node 22 a
 * pool is never dropped, not even once its last connection has closed, and each one holds about
 * 26 KB. The RPC sweep contacts some 3,400 hosts, so the heap grew by ~125 MB over the first
 * sweep and stayed there, close enough to the limit that the six-hourly registry reload ran the
 * process out of memory.
 *
 * Every FETCH_POOL_MAX_AGE_MS the agent is replaced by a fresh one. A replaced agent stays open
 * for two more intervals, because a fetch keeps the agent it started with for its whole life,
 * redirects included, and is then destroyed. Destroyed, not closed: a graceful close waits for
 * every response to be read to its end, so one nobody finishes reading would keep the agent and
 * its pools forever, and a destroy after a close that is still waiting does not end it.
 * The interval is never shorter than MIN_AGE_MS, so the two intervals outlast the requests made
 * here; anything still running on an agent after them is cut off.
 */
import { FETCH_POOL_MAX_AGE_MS } from '../../config.js';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';

// Where fetch looks up its agent. Set on the first request, so there is nothing to replace before it.
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

const MIN_AGE_MS = 60_000;
// The longest delay a timer takes; beyond it setInterval would fire every millisecond.
const MAX_AGE_MS = 2 ** 31 - 1;

let timer = null;
// The agents replaced last time and the time before, still open for the fetches that started on them.
let retired = [];

function destroy(agent) {
  Promise.resolve()
    .then(() => agent.destroy())
    .catch((err) => logger.warn({ err: err.message || err }, 'Destroying a replaced fetch agent failed'));
}

/**
 * Replace fetch's agent and move the earlier ones a round on (see above). Resolves true when it
 * was replaced. An agent someone configured (a proxy agent, say) is left alone: a fresh one
 * would lose its settings.
 */
export async function recycleConnectionPools() {
  const old = globalThis[GLOBAL_DISPATCHER];
  const Agent = old?.constructor;
  if (!old || Agent?.name !== 'Agent' || typeof old.destroy !== 'function') return false;
  globalThis[GLOBAL_DISPATCHER] = new Agent();
  incCounter('chains_api_fetch_pool_recycle_total');
  retired.unshift(old);
  for (const agent of retired.splice(2)) destroy(agent);
  return true;
}

export function startConnectionPoolRecycler() {
  if (timer) return;
  if (!FETCH_POOL_MAX_AGE_MS || FETCH_POOL_MAX_AGE_MS <= 0) {
    logger.info('Fetch connection pools are kept for the life of the process (FETCH_POOL_MAX_AGE_MS=0)');
    return;
  }
  timer = setInterval(() => { recycleConnectionPools().catch(() => {}); }, Math.min(Math.max(FETCH_POOL_MAX_AGE_MS, MIN_AGE_MS), MAX_AGE_MS));
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop replacing. The agents already replaced are destroyed; the current one stays in use. */
export function stopConnectionPoolRecycler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const agent of retired.splice(0)) destroy(agent);
}

/** Forget the replaced agents without destroying them. */
export function _resetConnectionPoolsForTests() {
  retired = [];
  stopConnectionPoolRecycler();
}
