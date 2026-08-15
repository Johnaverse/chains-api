import { getLiveEvents } from '../sources/liveIncidents.js';
import { getExplorerTip } from '../sources/blockscout.js';
import { buildForks, FORK_PHASE } from '../domain/forks.js';
import { logger } from '../util/logger.js';

/**
 * Serves fork entities: the read side of src/domain/forks.js.
 *
 * The domain module is pure and takes a `tipFor` injection; this is where that injection
 * becomes a real block explorer. Keeping the two apart is what lets the grouping and lifecycle
 * rules be tested without a network, and it is also why the explorer stays optional — a fork
 * whose activation is stated needs no lookup at all.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Chain tip lookup for converting an activation HEIGHT into a time.
 *
 * Only consulted for forks that give a height and no stated time (the observed Aleo case),
 * so the ordinary fork costs no explorer call. Returns null on any failure — a fork with an
 * unconvertible height stays `unscheduled`, which is honest, rather than acquiring a guessed
 * date.
 */
async function tipFor(chainId) {
  try {
    const tip = await getExplorerTip(chainId);
    if (!tip) return null;
    return { height: tip.height, timestampMs: tip.timestampMs, averageBlockSeconds: tip.averageBlockSeconds };
  } catch (err) {
    logger.debug({ chainId, err: err.message }, 'no chain tip for fork activation estimate');
    return null;
  }
}

/**
 * Forks assembled from the live status feed.
 *
 * @param {object} [opts]
 * @param {number} [opts.chainId] only forks touching this chain
 * @param {string} [opts.phase] one of upcoming|past|cancelled|unscheduled
 * @param {boolean} [opts.scheduledOnly] drop forks with no known activation time
 * @param {number} [opts.limit]
 */
export async function getForks({ chainId, phase, scheduledOnly = false, limit = DEFAULT_LIMIT } = {}) {
  const events = await getLiveEvents();
  const forks = await buildForks(events, { tipFor });

  let filtered = forks;
  if (chainId != null) filtered = filtered.filter((f) => f.chains.includes(Number(chainId)));
  if (phase) filtered = filtered.filter((f) => f.phase === phase);
  // A calendar wants only what can be placed on a day. Separate from `phase` because
  // "upcoming" and "has a date" are genuinely different questions — a fork can be announced
  // and real without anyone having named the day yet.
  if (scheduledOnly) filtered = filtered.filter((f) => f.activationAt !== null);

  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const sliced = filtered.slice(0, capped);
  return {
    fetchedAt: new Date().toISOString(),
    totalMatched: filtered.length,
    count: sliced.length,
    truncated: filtered.length > sliced.length,
    // Counts across everything matched, not just this page: a caller asking "how many upcoming
    // forks" must not have to add up a truncated list.
    byPhase: countByPhase(filtered),
    forks: sliced
  };
}

function countByPhase(forks) {
  const counts = Object.fromEntries(Object.values(FORK_PHASE).map((p) => [p, 0]));
  for (const fork of forks) counts[fork.phase] = (counts[fork.phase] ?? 0) + 1;
  return counts;
}
