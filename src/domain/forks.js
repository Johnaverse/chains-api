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
 * The `enrichment.fork` object every feed service emits, validated into the one shape this
 * module groups. Shared by the fork feeds and the live-incident feed so get_forks and
 * get_chain_upgrades read the same event the same way.
 */
export function slimFork(fork) {
  if (!fork || typeof fork !== 'object') return null;
  const { name, network, activationAt, activationBlock, state } = fork;
  return {
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    network: typeof network === 'string' && network.trim() ? network.trim() : null,
    // ISO only: V8's Date.parse reads prose too — "Oct 6" parses as a date in 2001.
    activationAt: typeof activationAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(activationAt) && Number.isFinite(Date.parse(activationAt)) ? activationAt : null,
    activationBlock: Number.isSafeInteger(activationBlock) ? activationBlock : null,
    state: typeof state === 'string' ? state : null
  };
}

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
  const group = forkGroup(fork, scope);
  return group ? group.key : null;
}

/** forkKey, with the parts kept apart so groups can be compared across scopes. */
function forkGroup(fork, scope) {
  if (!fork || !scope) return null;
  const name = forkIdentity(fork.name);
  if (name) return { key: `name:${name}@${scope}`, kind: 'name', ident: name };
  if (Number.isSafeInteger(fork.activationBlock) && fork.activationBlock > 0) {
    return { key: `block:${scope}:${fork.activationBlock}`, kind: 'block', ident: String(fork.activationBlock) };
  }
  // Marked, unnamed, no height — but a stated instant. Alchemy's "Ethereum Sepolia Hard Fork
  // Upgrade" gives only "October 6, 2026 at 13:53:36 UTC", and dropping it left the Sepolia
  // fork out entirely. Notices a few hours apart are clustered afterwards (clusterUnnamed),
  // because each provider states its own window start, not the activation second.
  const at = Date.parse(fork.activationAt ?? '');
  if (Number.isFinite(at)) {
    const iso = new Date(at).toISOString();
    return { key: `at:${scope}:${iso}`, kind: 'at', ident: iso };
  }
  return null;
}

/**
 * The fork's name as a grouping identity: normalized, and without the generic words sources
 * append — the EF says "Glamsterdam", CoinDesk "the Glamsterdam upgrade", a provider
 * "Glamsterdam hard fork". Digits are kept ("Protocol 28" ≠ "Protocol 29").
 */
export function forkIdentity(name) {
  const cleaned = normalizeForkName(name);
  if (!cleaned) return null;
  const stripped = cleaned
    .replace(/^the /, '')
    .replace(/ (network upgrade|protocol upgrade|hard ?fork|upgrade|fork)$/, '')
    .trim();
  // A name made only of generic words — "Protocol Upgrade", "Network Upgrade", "Hard Fork" —
  // identifies nothing: two unrelated notices on one network would merge under it. Such a
  // fork is treated as unnamed and grouped by height or time instead.
  if (cleaned.split(' ').every(w => GENERIC_FORK_WORDS.has(w))) return null;
  return stripped || cleaned;
}

const GENERIC_FORK_WORDS = new Set([
  'the', 'a', 'network', 'protocol', 'chain', 'mainnet', 'testnet', 'upgrade', 'upgrades', 'hard',
  'soft', 'fork', 'hardfork', 'softfork', 'scheduled', 'planned', 'emergency', 'mandatory',
  'node', 'client', 'software', 'release', 'maintenance', 'update', 'activation'
]);

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
  return scopesOf(event).scopes;
}

function scopesOf(event) {
  const named = [...new Set((event?.enrichment?.affectedChains ?? [])
    .map(name => scopeName(name))
    .filter(Boolean))];
  // The network that forks, when the source said — which is not always what the post is ABOUT:
  // Arbitrum's "Update L1-Pricing Parameters for Ethereum Glamsterdam" is about Arbitrum One,
  // but the fork is Ethereum's, and scoping it by the post's chains invented an Arbitrum fork.
  // It narrows the affected networks rather than replacing them: QuickNode's "Stellar - Mainnet
  // & Testnet" window names Stellar Mainnet as the network and still belongs to the testnet
  // activation too, so the same network's test networks named alongside it are kept.
  const forkNetwork = scopeName(event?.enrichment?.fork?.network);
  if (forkNetwork) {
    const family = named.filter(n => sameNetworkFamily(n, forkNetwork));
    return { scopes: family.includes(forkNetwork) ? family : [forkNetwork], forkNetwork, named };
  }
  if (named.length) return { scopes: named, forkNetwork: null, named };
  const chainIds = (event?.chains ?? []).map(c => c.chainId).filter(id => Number.isFinite(id));
  if (chainIds.length) return { scopes: [...new Set(chainIds.map(id => `chain:${id}`))], forkNetwork: null, named };
  // No network identity at all. Still groupable by codename, which is better than discarding
  // the fork — it just cannot be split per network.
  return { scopes: ['unscoped'], forkNetwork: null, named };
}

const TEST_NETWORK_WORD = /\b(testnet|test|devnet|sepolia|holesky|hoodi|goerli|futurenet|preview|preprod|staging|signet)\b/;

/**
 * "stellar" and "stellar testnet" are one network family; "ethereum" and "ethereum classic" are
 * not, which is why the extension must be a test-network qualifier and not any longer name.
 */
function sameNetworkFamily(a, b) {
  if (a === b) return true;
  const [base, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(`${base} `) && TEST_NETWORK_WORD.test(longer.slice(base.length));
}

/**
 * A network name as a scope. "Mainnet" is dropped because sources disagree on writing it — the
 * EF says "Ethereum", a provider "Ethereum Mainnet" — and an unqualified name means mainnet;
 * every other qualifier stays, since Sepolia and mainnet activate on different dates.
 */
export function scopeName(name) {
  const cleaned = normalizeForkName(name);
  if (!cleaned) return null;
  return cleaned.replace(/ main ?net$/, '').trim() || cleaned;
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
 * Strength first: a provider posts "coming soon" before the exact time, and a later vaguer note
 * must not overwrite a precise one. Then who said it — the network's own announcement over a
 * provider's window over a secondary outlet repeating a date — and recency within one rank.
 *
 * Rank alone would freeze a fork on its first official date, though: when a fork slips and the
 * network page is never edited, every newer provider window says the new day. So a NEWER claim
 * from a non-secondary source that moves the date by more than RESCHEDULE_MIN_MS is a
 * reschedule, and only claims made from then on are considered. The threshold is what keeps a
 * provider's window start (hours before the activation) from passing for one.
 */
const RESCHEDULE_MIN_MS = 24 * 60 * 60 * 1000;
const SECONDARY_RANK = 2;

export function bestActivation(candidates = []) {
  const usable = candidates.filter(c => c?.at && c.evidence);
  if (!usable.length) return null;
  const strength = Math.min(...usable.map(c => FORK_ACTIVATION_EVIDENCE.indexOf(c.evidence)));
  let pool = usable.filter(c => FORK_ACTIVATION_EVIDENCE.indexOf(c.evidence) === strength);
  const pick = (list) => [...list].sort((a, b) =>
    ((a.rank ?? 0) - (b.rank ?? 0)) || ((b.observedAt ?? 0) - (a.observedAt ?? 0)))[0];
  let best = pick(pool);
  for (;;) {
    const moved = pool.filter(c => (c.rank ?? 0) < SECONDARY_RANK
      && (c.observedAt ?? 0) > (best.observedAt ?? 0)
      && Math.abs(Date.parse(c.at) - Date.parse(best.at)) > RESCHEDULE_MIN_MS);
    if (!moved.length) return best;
    const since = Math.min(...moved.map(c => c.observedAt ?? 0));
    pool = pool.filter(c => (c.observedAt ?? 0) >= since);
    best = pick(pool);
  }
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
 * Lower is stronger: the network's own status page, a forum (where client teams and the
 * network post), and a primary outlet (the project's own blog) rank alike; a provider's window
 * is a provider's reading; secondary news is a report of someone else's announcement.
 */
export function sourceRank(event) {
  const feed = event?.feed ?? 'status';
  if (feed === 'news') return event.weight === 'primary' ? 0 : 2;
  if (feed === 'status') return event.statusPage?.kind === 'rpc-provider' ? 1 : 0;
  return 0;
}

// How far apart two unnamed notices of one activation may be. Providers state their own window
// start, typically an hour or a few before the activation second.
const UNNAMED_MATCH_MS = 6 * 60 * 60 * 1000;

function anchorsOf(members) {
  return {
    blocks: new Set(members.map(m => m.fork.activationBlock).filter(b => Number.isSafeInteger(b) && b > 0)),
    times: members.map(m => Date.parse(m.fork.activationAt ?? '')).filter(Number.isFinite)
  };
}

/** 0 = same height or same second, 1 = times within UNNAMED_MATCH_MS, null = unrelated. */
function anchorDistance(a, b) {
  if ([...a.blocks].some(x => b.blocks.has(x))) return 0;
  if (a.times.some(x => b.times.includes(x))) return 0;
  if (a.times.some(x => b.times.some(y => Math.abs(x - y) <= UNNAMED_MATCH_MS))) return 1;
  return null;
}

function mergeInto(groups, target, source) {
  target.members.push(...source.members);
  groups.delete(source.key);
}

/**
 * A mention scoped only by chainId (`chain:1`: no network name was extracted) is the same fork
 * as the name-scoped group whose chains include that id — otherwise Glamsterdam is listed once
 * as "ethereum" and once with no network. Merged only into a single unambiguous candidate.
 */
function mergeChainScopes(groups, chainIdsFor) {
  for (const group of [...groups.values()]) {
    if (!group.scope.startsWith('chain:')) continue;
    const chainId = Number(group.scope.slice('chain:'.length));
    const targets = [...groups.values()].filter(g => g !== group
      && g.kind === group.kind && g.ident === group.ident
      && g.scope !== 'unscoped' && !g.scope.startsWith('chain:')
      && (g.members.some(m => m.chainIds.includes(chainId)) || (chainIdsFor?.(g.scope) ?? []).includes(chainId)));
    if (targets.length === 1) mergeInto(groups, targets[0], group);
  }
}

/**
 * Unnamed groups (keyed by height or by instant) on one network that describe the same
 * activation become one: they share a height, or their times are within UNNAMED_MATCH_MS — one
 * provider states block 18813000 and its time, another only a window start half an hour earlier.
 * Each cluster then folds into the NAMED group on that network with the same activation: Alchemy
 * never names the Sepolia fork, the EF post names it Glamsterdam. A fold needs one candidate —
 * the exact match if there is one, else the only one in range; two named forks stay apart.
 */
function clusterUnnamed(groups) {
  const unnamed = [...groups.values()].filter(g => g.kind !== 'name');
  for (let i = 0; i < unnamed.length; i++) {
    const a = unnamed[i];
    if (!groups.has(a.key)) continue;
    for (let j = i + 1; j < unnamed.length; j++) {
      const b = unnamed[j];
      if (!groups.has(b.key) || b.scope !== a.scope) continue;
      if (anchorDistance(anchorsOf(a.members), anchorsOf(b.members)) !== null) {
        mergeInto(groups, a, b);
        j = i; // a's anchors grew; rescan the rest against them
      }
    }
  }
  const named = [...groups.values()].filter(g => g.kind === 'name');
  for (const group of [...groups.values()]) {
    if (group.kind === 'name') continue;
    const anchors = anchorsOf(group.members);
    const near = named
      .filter(g => g.scope === group.scope)
      .map(g => ({ g, d: anchorDistance(anchors, anchorsOf(g.members)) }))
      .filter(x => x.d !== null);
    const exact = near.filter(x => x.d === 0);
    const targets = exact.length ? exact : near;
    if (targets.length === 1) mergeInto(groups, targets[0].g, group);
  }
}

/**
 * The chains a mention attributes to one scope. When the source named the forking network,
 * the post's own chains are about the POSTER: an Arbitrum post on Ethereum's Glamsterdam
 * declares 42161, and attaching that to Ethereum's fork both converted its height with
 * Arbitrum's tip and listed it under `?chainId=42161`. Such a member takes the chains the
 * network name resolves to, and the post's chains only when the post is about that network.
 */
function memberChainIds({ scope, forkNetwork, named, eventChainIds, chainIdsFor }) {
  if (!forkNetwork) return eventChainIds;
  const resolved = chainIdsFor?.(scope) ?? [];
  if (resolved.length) return resolved;
  const aboutNetwork = named.length > 0 && named.every(n => sameNetworkFamily(n, forkNetwork));
  return aboutNetwork ? eventChainIds : [];
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
 * @param {(scope:string)=>number[]} [opts.chainIdsFor] the chainIds a network scope names
 * @param {number} [opts.now]
 * @returns {Promise<object[]>} forks, soonest upcoming first, then unscheduled, then past
 */
export async function buildForks(events = [], { tipFor = null, chainIdsFor = null, now = Date.now(), maxTipLookups = DEFAULT_MAX_TIP_LOOKUPS } = {}) {
  let tipBudget = maxTipLookups;
  const groups = new Map();
  for (const event of events) {
    const fork = event?.enrichment?.fork;
    if (!fork) continue;
    // Declared chains PLUS the ones the model named and the catalog resolved. Filtering on
    // declared chains alone under-reports: an OP Stack window naming nine networks declares
    // none of them, so `?chainId=` would answer "no forks" for a chain that is genuinely
    // affected. Same reasoning the incident feed already applies to its own chain filter.
    const eventChainIds = [...new Set([
      ...(event.chains ?? []).map(c => c.chainId),
      ...(event.enrichment?.chains ?? [])
    ])].filter(id => Number.isFinite(id));
    // One event may be about several networks ("Stellar - Mainnet & Testnet"), and each of those
    // is a separate activation with its own date. The event contributes to every one.
    const { scopes, forkNetwork, named } = scopesOf(event);
    for (const scope of scopes) {
      const group = forkGroup(fork, scope);
      if (!group) continue;
      const chainIds = memberChainIds({ scope, forkNetwork, named, eventChainIds, chainIdsFor });
      if (!groups.has(group.key)) groups.set(group.key, { ...group, scope, members: [] });
      groups.get(group.key).members.push({ event, fork, chainIds, scope });
    }
  }

  mergeChainScopes(groups, chainIdsFor);
  clusterUnnamed(groups);

  const forks = [];
  for (const { key, members } of groups.values()) {
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
      rank: sourceRank(m.event),
      observedAt: Date.parse(m.event.updatedAt ?? m.event.publishedAt ?? '') || 0
    }));
    const activation = bestActivation(candidates);
    const state = bestState(members.map(m => ({
      state: m.fork.state,
      observedAt: Date.parse(m.event.updatedAt ?? m.event.publishedAt ?? '') || 0
    })));

    const named = members.map(m => m.fork.name).find(Boolean) ?? null;
    const sources = [...new Set(members.map(m => m.event.statusPage?.id).filter(Boolean))];
    const feeds = [...new Set(members.map(m => m.event.feed ?? 'status'))];
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
      // Which KINDS of source: status pages, forums, news. A fork only news reported is a
      // claim to attribute, not a schedule the network published.
      feeds,
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
