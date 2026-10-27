import {
  CLIENT_FEED_URL, CLIENT_FEED_FETCH_TIMEOUT_MS, FORK_SOURCE_RECHECK_MS, FORK_SOURCE_PENDING_RETRY_MS,
  FORK_SOURCE_FAILED_RETRY_MS, FORK_SOURCE_NOT_FOUND_RETRY_MS
} from '../../config.js';
import { getFeed } from './feedHttp.js';
import { logger } from '../util/logger.js';

/**
 * Names for the forks a network's nodes report (nodeForkSchedule.js: a time and a fork id, no
 * name), from where the network's client code defines them: chains-client-feed's
 * `GET /fork-source?at=chainId:time,…` searches the repositories linked to the network for the
 * timestamp and reads the fork's name there — `JennerTime: newUint64(1793241000)` in
 * bnb-chain/bsc — with the rest of that network's schedule in the same configuration.
 *
 * The feed re-reads the code it found each period, so a found answer is asked again every
 * FORK_SOURCE_RECHECK_MS and a fork the client schedules later reaches the chain's history; the
 * feed answers `pending` while it looks (code search is slow and paced), retried after
 * FORK_SOURCE_PENDING_RETRY_MS. Optional: without CLIENT_FEED_URL nothing is asked and node forks
 * stay unnamed.
 */

// The feed's own limit per request.
const MAX_PAIRS = 50;

// `${chainId}:${time}` -> { status, askedAt, ...answer }
let answers = new Map();
let inFlight = null;
let version = 0;

export function _resetForkSourcesForTests() {
  answers = new Map();
  inFlight = null;
  version = 0;
}

const keyOf = (chainId, time) => `${chainId}:${time}`;

/** Changes whenever a name or schedule arrives: part of the fork memo key. */
export function forkSourceVersion() {
  return version;
}

/** The feed's answer for one node fork, or null when none has arrived. */
export function forkSourceOf(chainId, time) {
  const a = answers.get(keyOf(chainId, time));
  return a?.status === 'found' ? a : null;
}

function due(a, now) {
  if (!a) return true;
  const wait = a.status === 'found' ? FORK_SOURCE_RECHECK_MS
    : a.status === 'not_found' ? FORK_SOURCE_NOT_FOUND_RETRY_MS
      : a.status === 'pending' ? FORK_SOURCE_PENDING_RETRY_MS
        : FORK_SOURCE_FAILED_RETRY_MS;
  return now - a.askedAt >= wait;
}

/**
 * Ask the feed about every `{chainId, time}` not answered yet (or due again). Fire-and-forget;
 * one request at a time, never throws.
 */
export function requestForkSources(pairs, { now = Date.now() } = {}) {
  if (!CLIENT_FEED_URL || inFlight) return inFlight;
  const wanted = [];
  const seen = new Set();
  for (const { chainId, time } of pairs) {
    const key = keyOf(chainId, time);
    if (seen.has(key) || !Number.isSafeInteger(chainId) || !Number.isSafeInteger(time) || time < 1e9 || time > 1e11) continue;
    seen.add(key);
    if (due(answers.get(key), now)) wanted.push({ chainId, time, key });
    if (wanted.length >= MAX_PAIRS) break;
  }
  if (!wanted.length) return null;
  inFlight = fetchAnswers(wanted, now).finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchAnswers(wanted, now) {
  const at = wanted.map((w) => `${w.chainId}:${w.time}`).join(',');
  try {
    const response = await getFeed(`${CLIENT_FEED_URL.replace(/\/+$/, '')}/fork-source?at=${at}`, CLIENT_FEED_FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const answered = new Set();
    for (const item of Array.isArray(body?.items) ? body.items : []) {
      const key = keyOf(Number(item?.chainId), Number(item?.time));
      if (!wanted.some((w) => w.key === key)) continue;
      answered.add(key);
      const answer = sanitize(item, now);
      const before = answers.get(key);
      // A name already found stays while the feed looks again; the schedule follows the code.
      if (answer.status !== 'found' && before?.status === 'found') { before.askedAt = now; continue; }
      if (answer.status === 'found' && JSON.stringify([before?.name, before?.forks]) !== JSON.stringify([answer.name, answer.forks])) version += 1;
      answers.set(key, answer);
    }
    // A pair the feed left out of its answer is a failed attempt, not one never made.
    for (const w of wanted) {
      if (answered.has(w.key)) continue;
      const before = answers.get(w.key);
      if (before?.status === 'found') before.askedAt = now;
      else answers.set(w.key, { status: 'failed', askedAt: now });
    }
  } catch (err) {
    logger.warn({ err: err.message, pairs: wanted.length }, 'fork source lookup failed');
    // Every pair asked records this attempt, so a retry that fails waits RETRY_FAILED_MS like
    // the first; a name already found is kept.
    for (const w of wanted) {
      const before = answers.get(w.key);
      if (before?.status === 'found') before.askedAt = now;
      else answers.set(w.key, { status: 'failed', askedAt: now });
    }
  }
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,59}$/u;

/** Only what is well-formed: a name, a GitHub location, and dated or block-height forks. */
function sanitize(item, now) {
  const status = ['found', 'not_found', 'pending', 'unavailable'].includes(item?.status) ? item.status : 'failed';
  if (status !== 'found' || typeof item.name !== 'string' || !NAME.test(item.name.trim())) {
    return { status: status === 'found' ? 'failed' : status, askedAt: now };
  }
  const repo = typeof item.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(item.repo) ? item.repo : null;
  const url = typeof item.url === 'string' && item.url.startsWith('https://github.com/') ? item.url : null;
  const forks = (Array.isArray(item.forks) ? item.forks : []).map((f) => ({
    name: typeof f?.name === 'string' && NAME.test(f.name.trim()) ? f.name.trim() : null,
    activationTime: Number.isSafeInteger(f?.activationTime) && f.activationTime > 0 && f.activationTime * 1000 <= 8.64e15 ? f.activationTime : null,
    activationBlock: Number.isSafeInteger(f?.activationBlock) && f.activationBlock > 0 ? f.activationBlock : null
  })).filter((f) => f.name && (f.activationTime || f.activationBlock));
  return { status, askedAt: now, name: item.name.trim(), repo, path: typeof item.path === 'string' ? item.path : null, url, forks };
}
