/**
 * Forks as first-class entities, assembled from the events that mention them.
 *
 * A fork is not an event. It is a thing many events talk about: the network announces it, then
 * each provider posts its own maintenance window to be ready for it, then someone reports what
 * broke afterwards. Grouping those under one identity is the whole point — measured on the live
 * feed, 134 upgrade events collapsed to 123 groups under the existing per-provider key, i.e.
 * essentially no cross-provider joining at all.
 *
 * Why the join is by fork IDENTITY and not by chain plus time: that was checked against the
 * feed and it does not work. Of the 7 cases where two providers announced work on the same
 * chain in the same week, NONE were the same upgrade — Chainstack's "Internal platform upgrades
 * / London" touches dozens of chains and coincides with everything. Proximity grouping would
 * have merged unrelated work and looked convincing doing it. The fork name does join correctly:
 * "Protocol 28" links three events across QuickNode and Stellar's own status page.
 *
 * Two things make this harder than a group-by:
 *
 *   TIMING IS OFTEN A HEIGHT, NOT A TIME. The observed Aleo fork activates "at block height
 *   18,813,000, predicted to occur around August 18". The height is the fact; the date is the
 *   provider's guess. So an activation carries its EVIDENCE, and a time derived from a height
 *   is never presented as though someone announced it.
 *
 *   SCHEDULES MOVE. Forks slip, get re-dated, and are occasionally called off. Each of those
 *   arrives as another event about the same fork, so the group resolves to the best current
 *   answer rather than the first one seen.
 */

/**
 * How well the activation time is known, strongest first. Mirrors the ACTIVATION_EVIDENCE idea
 * already used for maintenance windows: a consumer must be able to tell "the network said 03:00"
 * from "we multiplied a block gap by an average".
 */
export const FORK_ACTIVATION_EVIDENCE = ['stated', 'observed', 'estimated'];

// Ceiling on explorer round trips for one buildForks call, and on candidate chains per fork.
// The client paces requests process-wide, so these bound worst-case latency for the caller and
// protect the shared rate budget rather than being about correctness.
const DEFAULT_MAX_TIP_LOOKUPS = 8;
const MAX_TIP_CHAINS_PER_FORK = 2;

/** Where a fork sits relative to now. */
export const FORK_PHASE = Object.freeze({
  UPCOMING: 'upcoming',
  PAST: 'past',
  CANCELLED: 'cancelled',
  // Marked as a fork, but nothing yet says when. Deliberately distinct from `upcoming`: the
  // calendar shows only forks whose timing is known, and conflating the two would put undated
  // forks on a date.
  UNSCHEDULED: 'unscheduled'
});

/**
 * The grouping identity of a fork.
 *
 * Prefers the codename because that is what actually travels between providers. Falls back to
 * chain + activation height, which is what the Aleo case gives — marked as a fork, never named,
 * but pinned to height 18,813,000, and any other provider describing that upgrade will cite the
 * same height.
 *
 * @returns {string|null} null when the event carries no fork identity at all
 */
export function forkKey(fork, scope) {
  if (!fork || !scope) return null;
  const name = normalizeForkName(fork.name);
  if (name) return `name:${name}@${scope}`;
  if (Number.isSafeInteger(fork.activationBlock) && fork.activationBlock > 0) {
    return `block:${scope}:${fork.activationBlock}`;
  }
  return null;
}

/**
 * The networks one event is about, as grouping scopes.
 *
 * A fork is scoped to a NETWORK, not to a codename, because the same upgrade reaches each
 * network on its own schedule. Live proof: Stellar's Protocol 28 activates on Testnet on Aug 27
 * and on Mainnet on Sep 16, while QuickNode runs one infrastructure window on Aug 20 covering
 * both. Keying on the codename alone collapsed all three into a single fork with a single date —
 * which would have been wrong for at least one network, and silently.
 *
 * `affectedChains` is the best source available: the classifier is explicitly instructed to keep
 * the qualifier the text uses ("Stellar Mainnet", not "Stellar"), and it works for non-EVM
 * networks that have no chainId at all — which is 171 of the live events, and every Stellar one.
 * chainId is the fallback where the name was not extracted.
 */
export function forkScopes(event) {
  const named = (event?.enrichment?.affectedChains ?? [])
    .map(name => normalizeForkName(name))
    .filter(Boolean);
  if (named.length) return [...new Set(named)];
  const chainIds = (event?.chains ?? []).map(c => c.chainId).filter(id => Number.isFinite(id));
  if (chainIds.length) return [...new Set(chainIds.map(id => `chain:${id}`))];
  // No network identity at all. Still groupable by codename, which is better than discarding
  // the fork — it just cannot be split per network.
  return ['unscoped'];
}

/**
 * Fork names are written differently by every source ("Protocol 28", "protocol-28", "PROTOCOL
 * 28"), so the key is case- and punctuation-insensitive. Deliberately NOT stripping digits:
 * "Protocol 28" and "Protocol 29" are different forks.
 */
export function normalizeForkName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return cleaned || null;
}

/**
 * Resolve when a fork activates, and say how confidently.
 *
 * A stated time always wins. Otherwise a height can be turned into a time using the chain's own
 * tip and block rate — looked up for a height already reached, estimated for one still ahead.
 * The estimate is explicitly labelled because block rates drift: multiplying a two-million-block
 * gap by an average is an order-of-magnitude answer, not a schedule.
 *
 * @param {object} fork the enrichment's fork object
 * @param {object} [tip] {height, timestampMs, averageBlockSeconds} from a block explorer
 * @returns {{at: string|null, evidence: string|null, block: number|null}}
 */
export function resolveForkActivation(fork, tip = null) {
  const block = Number.isSafeInteger(fork?.activationBlock) && fork.activationBlock > 0 ? fork.activationBlock : null;

  const stated = typeof fork?.activationAt === 'string' ? Date.parse(fork.activationAt) : NaN;
  if (Number.isFinite(stated)) {
    return { at: new Date(stated).toISOString(), evidence: 'stated', block };
  }

  if (block === null || !tip || !Number.isFinite(tip.height) || !Number.isFinite(tip.timestampMs)) {
    return { at: null, evidence: null, block };
  }

  const rate = Number(tip.averageBlockSeconds);
  if (!Number.isFinite(rate) || rate <= 0) return { at: null, evidence: null, block };

  // Both directions use the same arithmetic; only the confidence differs. A height already
  // passed could be read exactly from the explorer, but deriving it from the tip keeps this
  // function pure — the caller supplies an exact timestamp as `stated` when it has one.
  const deltaSeconds = (block - tip.height) * rate;
  const at = new Date(tip.timestampMs + deltaSeconds * 1000).toISOString();
  return { at, evidence: block <= tip.height ? 'observed' : 'estimated', block };
}

/**
 * Where a fork stands right now.
 *
 * Cancellation cannot be inferred — a called-off fork looks exactly like one nobody mentioned
 * again — so it is only ever reported when a source said so.
 */
export function forkPhase({ activationAt, state }, now = Date.now()) {
  if (state === 'cancelled') return FORK_PHASE.CANCELLED;
  const t = Date.parse(activationAt ?? '');
  if (!Number.isFinite(t)) return FORK_PHASE.UNSCHEDULED;
  return t > now ? FORK_PHASE.UPCOMING : FORK_PHASE.PAST;
}

/**
 * Pick the best activation across every event that mentions one fork.
 *
 * Strength first, then recency. Strength first because a provider posts "coming soon" before
 * the exact time, and a later vaguer note must not overwrite a precise one. Recency within a
 * strength level because that is exactly what a reschedule looks like: the same kind of claim,
 * made again, with a different answer.
 */
export function bestActivation(candidates = []) {
  const ranked = candidates
    .filter(c => c?.at && c.evidence)
    .sort((a, b) => {
      const byEvidence = FORK_ACTIVATION_EVIDENCE.indexOf(a.evidence) - FORK_ACTIVATION_EVIDENCE.indexOf(b.evidence);
      if (byEvidence !== 0) return byEvidence;
      return (b.observedAt ?? 0) - (a.observedAt ?? 0);
    });
  return ranked[0] ?? null;
}

/**
 * The strongest lifecycle statement made about a fork.
 *
 * `cancelled` outranks everything: once a source says a fork is off, a stale "scheduled" from an
 * older announcement must not resurrect it. Otherwise the most recent statement wins.
 */
export function bestState(statements = []) {
  const withState = statements.filter(s => s?.state);
  if (withState.some(s => s.state === 'cancelled')) return 'cancelled';
  return withState.sort((a, b) => (b.observedAt ?? 0) - (a.observedAt ?? 0))[0]?.state ?? null;
}

/**
 * Assemble fork entities from enriched status events.
 *
 * Every event carrying a fork identity contributes what it knows; the fork resolves to the best
 * current answer. An event with no fork identity is simply not part of any fork — this never
 * guesses, because a wrong grouping is worse than none: it would attribute one network's
 * upgrade to another's window.
 *
 * @param {object[]} events enriched status events (each may carry `enrichment.fork`)
 * @param {object} [opts]
 * @param {(chainId:number)=>object|null} [opts.tipFor] chain tip lookup, for height-only forks
 * @param {number} [opts.now]
 * @returns {Promise<object[]>} forks, soonest upcoming first, then unscheduled, then past
 */
export async function buildForks(events = [], { tipFor = null, now = Date.now(), maxTipLookups = DEFAULT_MAX_TIP_LOOKUPS } = {}) {
  let tipBudget = maxTipLookups;
  const byKey = new Map();
  for (const event of events) {
    const fork = event?.enrichment?.fork;
    if (!fork) continue;
    // Declared chains PLUS the ones the model named and the catalog resolved. Filtering on
    // declared chains alone under-reports: an OP Stack window naming nine networks declares
    // none of them, so `?chainId=` would answer "no forks" for a chain that is genuinely
    // affected. Same reasoning the incident feed already applies to its own chain filter.
    const chainIds = [...new Set([
      ...(event.chains ?? []).map(c => c.chainId),
      ...(event.enrichment?.chains ?? [])
    ])].filter(id => Number.isFinite(id));
    // One event may be about several networks ("Stellar - Mainnet & Testnet"), and each of those
    // is a separate activation with its own date. The event contributes to every one.
    for (const scope of forkScopes(event)) {
      const key = forkKey(fork, scope);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ event, fork, chainIds, scope });
    }
  }

  const forks = [];
  for (const [key, members] of byKey) {
    const chainIds = [...new Set(members.flatMap(m => m.chainIds))];
    // A tip is only fetched when some member needs a height converted, so the common
    // stated-time fork costs no explorer call at all.
    const needsTip = members.some(m => m.fork.activationBlock && !m.fork.activationAt);
    let tip = null;
    if (needsTip && tipFor && tipBudget > 0) {
      // Bounded on purpose. Tip lookups are serialised by the explorer client's shared rate
      // limiter, so an unbounded loop over height-only forks could stall one request for
      // minutes AND drain the rate budget the halt check depends on. Past the budget a fork
      // keeps its height and stays unscheduled, which is the same honest answer as an
      // unreachable explorer.
      for (const chainId of chainIds.slice(0, MAX_TIP_CHAINS_PER_FORK)) {
        tipBudget -= 1;
        tip = await tipFor(chainId);
        if (tip) break;
      }
    }

    const candidates = members.map(m => ({
      ...resolveForkActivation(m.fork, tip),
      observedAt: Date.parse(m.event.updatedAt ?? m.event.publishedAt ?? '') || 0
    }));
    const activation = bestActivation(candidates);
    const state = bestState(members.map(m => ({
      state: m.fork.state,
      observedAt: Date.parse(m.event.updatedAt ?? m.event.publishedAt ?? '') || 0
    })));

    const named = members.map(m => m.fork.name).find(Boolean) ?? null;
    const sources = [...new Set(members.map(m => m.event.statusPage?.id).filter(Boolean))];
    forks.push({
      key,
      name: named,
      // The network this activation belongs to. Two entries can share a codename and differ
      // here — that is the normal case, not a duplicate.
      network: members[0].scope,
      chains: chainIds,
      activationAt: activation?.at ?? null,
      // How the time was arrived at. A consumer that will not show a guess as a schedule needs
      // this, and the calendar shows only forks whose timing is known at all.
      activationEvidence: activation?.evidence ?? null,
      activationBlock: candidates.map(c => c.block).find(b => b != null) ?? null,
      state,
      phase: forkPhase({ activationAt: activation?.at ?? null, state }, now),
      // Which status pages reported it — the point of the exercise. More than one means the
      // cross-provider join actually fired.
      sources,
      events: members
        .map(m => m.event)
        .sort((a, b) => (Date.parse(a.publishedAt ?? '') || 0) - (Date.parse(b.publishedAt ?? '') || 0))
    });
  }

  const rank = { [FORK_PHASE.UPCOMING]: 0, [FORK_PHASE.UNSCHEDULED]: 1, [FORK_PHASE.CANCELLED]: 2, [FORK_PHASE.PAST]: 3 };
  return forks.sort((a, b) => {
    if (rank[a.phase] !== rank[b.phase]) return rank[a.phase] - rank[b.phase];
    const ta = Date.parse(a.activationAt ?? '') || 0;
    const tb = Date.parse(b.activationAt ?? '') || 0;
    // Upcoming: soonest first. Past: most recent first.
    return a.phase === FORK_PHASE.PAST ? tb - ta : ta - tb;
  });
}
