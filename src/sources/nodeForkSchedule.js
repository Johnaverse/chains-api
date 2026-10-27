import { jsonRpcCall } from '../../rpcUtil.js';
import { NODE_FORK_SCHEDULE_REFRESH_MS, NODE_FORK_SCHEDULE_RETRY_MS, NODE_FORK_SCHEDULE_MAX_URLS, NODE_FORK_SCHEDULE_MAX_AHEAD_MS, RPC_CHECK_TIMEOUT_MS } from '../../config.js';

/**
 * Each chain's fork schedule as its own nodes are configured with it: `eth_config` (EIP-7910),
 * asked of an RPC the chain refresher found working.
 *
 * Announcements are written by people and read by a model; a node's config is what activates.
 * BSC Chapel's Jenner was scheduled for 2026-10-29 02:30 UTC — fork id 0xe660a57e, every node
 * ready — while no feed had placed it on the chain. The node answers `current`, `next` and
 * `last`, each with its activation time and fork id (EIP-2124), but no fork name: a schedule
 * names its fork only by joining a named one at the same instant (src/domain/forks.js).
 *
 * Many public RPCs refuse the method (gateways, rate-limited demo keys), so up to
 * NODE_FORK_SCHEDULE_MAX_URLS working endpoints are tried, and a chain where none answers waits
 * NODE_FORK_SCHEDULE_RETRY_MS. An answer for another chain id is a misconfigured or
 * misattributed endpoint, never this chain's schedule.
 */


// chainId -> { checkedAt, url, current, next, last } or { checkedAt, unsupported: true }
let schedules = new Map();
let inFlight = new Set();
let version = 0;

export function _setNodeForkScheduleForTests(chainId, entry) {
  schedules.set(chainId, entry);
  version += 1;
}

export function _resetNodeForkSchedulesForTests() {
  schedules = new Map();
  inFlight = new Set();
  version = 0;
}

/** One `current` / `next` / `last` entry, or null when the node has none or it is not this chain's. */
function forkOf(entry, chainId) {
  if (!entry || typeof entry !== 'object') return null;
  const time = Number(entry.activationTime);
  const id = typeof entry.chainId === 'string' ? Number.parseInt(entry.chainId, 16) : Number(entry.chainId);
  // A time a Date cannot hold (past ±8.64e15 ms) would throw in toISOString on every /forks read.
  if (!Number.isSafeInteger(time) || time < 0 || time * 1000 > 8.64e15 || id !== chainId) return null;
  return { activationTime: time, forkId: typeof entry.forkId === 'string' ? entry.forkId.toLowerCase() : null };
}

/** The schedule in an `eth_config` result, or null when it is not one for this chain. */
export function parseEthConfig(result, chainId) {
  if (!result || typeof result !== 'object') return null;
  const current = forkOf(result.current, chainId);
  if (!current) return null;
  return { current, next: forkOf(result.next, chainId), last: forkOf(result.last, chainId) };
}

/**
 * Re-read one chain's schedule when it is due. `urls`: endpoints the refresher just found
 * serving blocks. Fire-and-forget from the refresher; never throws.
 */
export async function refreshNodeForkSchedule(chainId, urls, { now = Date.now() } = {}) {
  const known = schedules.get(chainId);
  const wait = known?.unsupported ? NODE_FORK_SCHEDULE_RETRY_MS : NODE_FORK_SCHEDULE_REFRESH_MS;
  if ((known && now - known.checkedAt < wait) || inFlight.has(chainId) || !urls?.length) return known ?? null;
  inFlight.add(chainId);
  try {
    for (const url of urls.slice(0, NODE_FORK_SCHEDULE_MAX_URLS)) {
      let schedule = null;
      try {
        schedule = parseEthConfig(await jsonRpcCall(url, 'eth_config', { timeoutMs: RPC_CHECK_TIMEOUT_MS }), chainId);
      } catch {
        continue;
      }
      if (!schedule) continue;
      const changed = JSON.stringify([known?.current, known?.next, known?.last]) !== JSON.stringify([schedule.current, schedule.next, schedule.last]);
      // Since when this exact next fork has been seen: when the schedule became known.
      const nextSince = known?.next?.forkId && known.next.forkId === schedule.next?.forkId ? known.nextSince : now;
      const entry = { checkedAt: now, url, ...schedule, nextSince };
      schedules.set(chainId, entry);
      if (changed) version += 1;
      return entry;
    }
    // None answered: keep a schedule read before (an endpoint may have gone), retry later.
    schedules.set(chainId, known && !known.unsupported ? { ...known, checkedAt: now } : { checkedAt: now, unsupported: true });
    return schedules.get(chainId);
  } finally {
    inFlight.delete(chainId);
  }
}

/** Changes whenever a schedule changes: part of the fork memo key. */
export function nodeForkScheduleVersion() {
  return version;
}

/**
 * Fork mentions, in src/sources/forkFeeds.js's shape (feed `node`), one per distinct fork in
 * every schedule read: the last one activated and the scheduled ones. `nameOf(chainId)` names
 * the chain in the title.
 */
export function nodeForkMentions({ now = Date.now(), nameOf = () => null, sourceOf = () => null } = {}) {
  const mentions = [];
  for (const [chainId, s] of schedules) {
    if (s.unsupported) continue;
    const seen = new Set();
    // Where the chain's client code defines these forks (forkSource.js): the name the node does
    // not give, and the rest of the chain's schedule in that configuration — its fork history.
    const sources = [];
    for (const [which, fork] of [['current', s.current], ['next', s.next], ['last', s.last]]) {
      if (!fork || fork.activationTime === 0 || seen.has(fork.activationTime)) continue;
      // Parked far ahead (2030-01-01, 2050-01-01): a fork the client has not scheduled.
      if (fork.activationTime * 1000 - now > NODE_FORK_SCHEDULE_MAX_AHEAD_MS) continue;
      seen.add(fork.activationTime);
      const at = new Date(fork.activationTime * 1000).toISOString();
      const done = fork.activationTime * 1000 <= now;
      const source = sourceOf(chainId, fork.activationTime);
      if (source) sources.push(source);
      const chain = nameOf(chainId) ?? `chain ${chainId}`;
      // A scheduled fork is announced when the node schedule first showed it; one already
      // active, when it was read.
      const announcedAt = new Date(which === 'current' || done ? s.checkedAt : (s.nextSince ?? s.checkedAt)).toISOString();
      mentions.push({
        // No URL to de-duplicate by: the chain, fork id and instant are the event.
        id: `node:${chainId}:${fork.forkId ?? 'unknown'}:${fork.activationTime}`,
        feed: 'node',
        title: `${chain}: ${done ? 'fork active since' : 'fork scheduled for'} ${at} (fork id ${fork.forkId ?? 'unknown'}, eth_config)`,
        url: null,
        publishedAt: announcedAt,
        updatedAt: new Date(s.checkedAt).toISOString(),
        status: null,
        chains: [{ chainId }],
        statusPage: { id: 'node:eth_config', name: 'Node fork schedule (eth_config)', kind: 'node' },
        weight: null,
        enrichment: {
          class: 'planned_hard_fork',
          createdAt: announcedAt,
          affectedChains: [],
          chains: [chainId],
          fork: {
            name: source?.name ?? null,
            network: null,
            activationAt: at,
            activationBlock: null,
            state: done ? 'completed' : 'scheduled',
            forkId: fork.forkId
          }
        }
      });
    }
    mentions.push(...sourceMentions(chainId, sources, { now, chain: nameOf(chainId) ?? `chain ${chainId}` }));
  }
  return mentions;
}

/**
 * The chain's schedule as its client code states it, one dated (or height-only) mention per
 * fork, de-duplicated across the files the node's forks were found in. Feed `source`; placed on
 * the chain by `chainIds`, so a fork the feeds no longer hold (Tempo's T8–T10, Ethereum's BPO2)
 * is still in the chain's history.
 */
function sourceMentions(chainId, sources, { now, chain }) {
  const out = [];
  const seen = new Set();
  for (const source of sources) {
    for (const f of source.forks ?? []) {
      const key = `${f.name.toLowerCase()}|${f.activationTime ?? ''}|${f.activationBlock ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = f.activationTime ? new Date(f.activationTime * 1000).toISOString() : null;
      // A height-only fork's state is unknown here: whether the chain reached the height is the
      // explorer's to say (resolveForkActivation), never assumed done.
      const state = at ? (Date.parse(at) <= now ? 'completed' : 'scheduled') : null;
      // Claimed when the feed read the code, not when the node was last asked.
      const readAt = new Date(source.readAt ?? source.askedAt ?? now).toISOString();
      out.push({
        id: `source:${chainId}:${source.repo ?? 'unknown'}:${key}`,
        feed: 'source',
        title: `${chain}: ${f.name} ${at ? `at ${at}` : `at block ${f.activationBlock}`} (${source.repo ?? 'client code'}${source.path ? ` ${source.path}` : ''})`,
        url: source.url ?? null,
        publishedAt: readAt,
        updatedAt: readAt,
        status: null,
        chains: [{ chainId }],
        statusPage: { id: `source:${source.repo ?? 'unknown'}`, name: source.repo ?? 'Client code', kind: 'source' },
        weight: null,
        enrichment: {
          class: 'planned_hard_fork',
          createdAt: readAt,
          affectedChains: [],
          chains: [chainId],
          fork: {
            name: f.name,
            network: null,
            activationAt: at,
            activationBlock: at ? null : f.activationBlock,
            state,
            chainIds: [chainId]
          }
        }
      });
    }
  }
  return out;
}

/** Every chain-and-time pair the schedules read so far report: what forkSource.js is asked. */
export function nodeForkPairs() {
  const pairs = [];
  for (const [chainId, s] of schedules) {
    if (s.unsupported) continue;
    for (const fork of [s.current, s.next, s.last]) {
      if (fork?.activationTime > 0 && fork.activationTime * 1000 - Date.now() <= NODE_FORK_SCHEDULE_MAX_AHEAD_MS) pairs.push({ chainId, time: fork.activationTime });
    }
  }
  return pairs;
}

/** Every schedule read, for /forks' `feeds` summary and the review of disagreements. */
export function getNodeForkSchedules() {
  return schedules;
}
