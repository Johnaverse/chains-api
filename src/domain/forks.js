import { mentionsTestNetwork } from './networkWords.js';

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
 * Every fork object one feed item carries. chains-news sends `enrichment.forks` (same entry
 * shape) when one post names two or more activations; that array INCLUDES the primary entry
 * `enrichment.fork` also holds, and may come with `fork: null`. So: `forks` when present, else
 * `[fork]` — never both, which would count the primary twice. Each entry is its own mention.
 */
export function forksOf(enrichment) {
  if (!enrichment || typeof enrichment !== 'object') return [];
  const raw = Array.isArray(enrichment.forks) && enrichment.forks.length ? enrichment.forks : [enrichment.fork];
  const seen = new Set();
  const out = [];
  for (const f of raw) {
    const slim = slimFork(f);
    if (!slim) continue;
    const id = JSON.stringify(slim);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(slim);
  }
  return out;
}

/**
 * Classes that by themselves mark a fork. Everything else (`planned_software_update`,
 * `urgent_software_fix`, ...) can still carry `enrichment.fork` — a provider window that
 * PREPARES for a fork is classed as the provider's software update and carries the fork so it
 * groups with the network's announcement — but on its own it is evidence of an upgrade, not
 * of a fork. `hard_fork` is the previous taxonomy's name, still present in archived events.
 */
export const FORK_CLASSES = new Set(['planned_hard_fork', 'hard_fork']);

/** What a fork entry is: a consensus fork / network upgrade, or an ordinary software update. */
export const FORK_KIND = Object.freeze({ FORK: 'fork', UPGRADE: 'upgrade' });

// "v29.0.1", "1.58", "testnet-v4.9.1": a release number, not a codename.
const VERSION_NAME = /\bv?\d+\.\d+/i;

/**
 * Whether a group of mentions is a fork, or an ordinary software update that happened to be
 * marked. Measured on the live feed, 7 of 9 "forks" were client releases and RPC patches
 * (Nanoreth, a v29.0.1 patch named "Protocol 29", a Celestia server setup, a Sui testnet
 * client bump), so the class is the first test — but not the only one, because the Stellar
 * "Protocol 28" activation reaches the feed mostly as provider windows classed as software
 * updates. The rule, in order:
 *
 *   1. any member classed as a hard fork                                       -> fork
 *   2. no member has a class at all (older payloads; nothing to judge on)      -> fork
 *   3. an activation HEIGHT (software updates do not activate at a block)      -> fork
 *   4. a real name (not generic, not a version number) AND a stated activation -> fork
 *   5. otherwise                                                               -> upgrade
 */
export function forkKind(members, activation) {
  const classes = members.map(m => m.event?.enrichment?.class).filter(c => typeof c === 'string' && c);
  if (classes.some(c => FORK_CLASSES.has(c))) return FORK_KIND.FORK;
  if (!classes.length) return FORK_KIND.FORK;
  if (members.some(m => Number.isSafeInteger(m.fork.activationBlock) && m.fork.activationBlock > 0)) return FORK_KIND.FORK;
  const named = members.some(m => forkIdentity(m.fork.name) && !VERSION_NAME.test(m.fork.name));
  if (named && activation?.evidence === 'stated') return FORK_KIND.FORK;
  return FORK_KIND.UPGRADE;
}

/** A date with no time of day ("2026-09-16"): the day is known, the instant is not. */
export function isDateOnly(activationAt) {
  return typeof activationAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(activationAt.trim());
}

// How far before its own announcement a stated activation may lie and still be believed.
// The classifier fills in a year the text did not give: Solana's Alpenglow, announced in 2026,
// came back as 2024-10-21. A notice describing an activation months in its own past is
// almost always that, not news.
const MAX_STATED_BEFORE_ANNOUNCEMENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The fork as one mention states it, minus a stated time that cannot be right: more than
 * MAX_STATED_BEFORE_ANNOUNCEMENT_MS before the mention was published. A `completed` fork is
 * exempt — a retrospective legitimately dates an activation long past. The height, name and
 * state survive; only the implausible time is dropped (the mention becomes undated rather
 * than acquiring a guessed year).
 */
export function plausibleFork(fork, announcedMs) {
  if (!fork?.activationAt || fork.state === 'completed' || !Number.isFinite(announcedMs)) return fork;
  const at = Date.parse(fork.activationAt);
  if (!Number.isFinite(at) || at >= announcedMs - MAX_STATED_BEFORE_ANNOUNCEMENT_MS) return fork;
  return { ...fork, activationAt: null, implausibleActivationAt: fork.activationAt };
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

/**
 * The scopes under which a registry chain name can be found. The registry writes test networks
 * both bare ("Sepolia") and qualified ("Base Sepolia Testnet"), sources write "Ethereum Sepolia"
 * and "Base Sepolia", so a name is indexed with a trailing "testnet" dropped as well, and a
 * qualified scope is also looked up by its test-network tail alone.
 */
export function registryScopes(name) {
  const scope = scopeName(name);
  if (!scope) return [];
  const bare = scope.replace(/ testnet$/, '');
  return [...new Set([scope, bare])];
}

export function scopeLookups(scope) {
  if (typeof scope !== 'string' || !scope) return [];
  const words = scope.split(' ');
  const tail = words.slice(1).join(' ');
  return words.length > 1 && mentionsTestNetwork(tail) ? [scope, tail] : [scope];
}

/**
 * "stellar" and "stellar testnet" are one network family; "ethereum" and "ethereum classic" are
 * not, which is why the extension must be a test-network qualifier and not any longer name.
 */
function sameNetworkFamily(a, b) {
  if (a === b) return true;
  const [base, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.startsWith(`${base} `) && mentionsTestNetwork(longer.slice(base.length));
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
    // A date-only statement ("2026-09-16") names the day, not midnight UTC: `precision: 'day'`
    // keeps a consumer from counting down to 00:00:00 or calling it past at 00:01.
    return { at: new Date(stated).toISOString(), evidence: 'stated', block, precision: isDateOnly(fork.activationAt) ? 'day' : 'time' };
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
  return { at, evidence: block <= tip.height ? 'observed' : 'estimated', block, precision: 'time' };
}

/**
 * Where a fork stands right now.
 *
 * Cancellation cannot be inferred — a called-off fork looks exactly like one nobody mentioned
 * again, so it is only ever reported when a source said so. `completed` is past whether or
 * not anyone gave the date (dYdX v9.8.0 was reported done, never dated, and read as
 * unscheduled). A day-precision activation stays upcoming until that UTC day is over.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export function forkPhase({ activationAt, state, activationPrecision = null }, now = Date.now()) {
  if (state === 'cancelled') return FORK_PHASE.CANCELLED;
  if (state === 'completed') return FORK_PHASE.PAST;
  const t = Date.parse(activationAt ?? '');
  if (!Number.isFinite(t)) return FORK_PHASE.UNSCHEDULED;
  const end = activationPrecision === 'day' ? t + DAY_MS : t;
  return end > now ? FORK_PHASE.UPCOMING : FORK_PHASE.PAST;
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
    if (!moved.length) return sharpen(best, pool);
    const since = Math.min(...moved.map(c => c.observedAt ?? 0));
    pool = pool.filter(c => (c.observedAt ?? 0) >= since);
    best = pick(pool);
  }
}

/**
 * A day-only winner gives way to a precise claim on that same UTC day: "2026-09-16" from the
 * network and "2026-09-16T17:00Z" from a provider are one statement at two resolutions.
 */
function sharpen(best, pool) {
  if (best.precision !== 'day') return best;
  const day = best.at.slice(0, 10);
  const precise = pool.filter(c => c.precision !== 'day' && c.at.slice(0, 10) === day
    && (c.rank ?? 0) < SECONDARY_RANK);
  if (!precise.length) return best;
  return [...precise].sort((a, b) => ((a.rank ?? 0) - (b.rank ?? 0)) || ((b.observedAt ?? 0) - (a.observedAt ?? 0)))[0];
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
  // A post from ANOTHER network about this fork is indirect, however official its own forum
  // or blog: Arbitrum's governance thread on Ethereum's Glamsterdam is Arbitrum's reading of
  // Ethereum's schedule, and must not tie Ethereum's own announcement or outrank a provider.
  const { forkNetwork, named } = scopesOf(event);
  if (forkNetwork && named.length && !named.some(n => sameNetworkFamily(n, forkNetwork))) return SECONDARY_RANK;
  const feed = event?.feed ?? 'status';
  if (feed === 'news') return event.weight === 'primary' ? 0 : SECONDARY_RANK;
  if (feed === 'status') return event.statusPage?.kind === 'rpc-provider' ? 1 : 0;
  // forum, and release: a client team's own release notes are the network's schedule.
  return 0;
}

// How far apart two unnamed notices of one activation may be. Providers state their own window
// start, typically an hour or a few before the activation second.
const UNNAMED_MATCH_MS = 6 * 60 * 60 * 1000;

/**
 * A member's activation height and stated instant, parsed once. The pairwise clustering below
 * used to re-parse every member's time on every comparison — about a second of CPU at 1,500
 * unnamed mentions.
 */
function memberAnchor(member) {
  if (!member.anchor) {
    const block = member.fork.activationBlock;
    member.anchor = {
      block: Number.isSafeInteger(block) && block > 0 ? block : null,
      time: Date.parse(member.fork.activationAt ?? '')
    };
  }
  return member.anchor;
}

function anchorsOf(members) {
  const blocks = new Set();
  const times = [];
  for (const m of members) {
    const { block, time } = memberAnchor(m);
    if (block !== null) blocks.add(block);
    if (Number.isFinite(time)) times.push(time);
  }
  return { blocks, times };
}

/** 0 = same height or same second, 1 = times within UNNAMED_MATCH_MS, null = unrelated. */
function anchorDistance(a, b) {
  for (const x of a.blocks) if (b.blocks.has(x)) return 0;
  let near = false;
  for (const x of a.times) {
    for (const y of b.times) {
      if (x === y) return 0;
      if (Math.abs(x - y) <= UNNAMED_MATCH_MS) near = true;
    }
  }
  return near ? 1 : null;
}

function mergeInto(groups, target, source) {
  target.members.push(...source.members);
  groups.delete(source.key);
}

/** Groups indexed by `kind:ident`, the part of the key that is the same across scopes. */
function byIdentity(groups) {
  const index = new Map();
  for (const g of groups.values()) {
    const id = `${g.kind}:${g.ident}`;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(g);
  }
  return index;
}

/**
 * A mention scoped only by chainId (`chain:1`: no network name was extracted) is the same fork
 * as the name-scoped group whose chains include that id — otherwise Glamsterdam is listed once
 * as "ethereum" and once with no network. Merged only into a single unambiguous candidate.
 */
function mergeChainScopes(groups, chainIdsFor) {
  const index = byIdentity(groups);
  for (const group of [...groups.values()]) {
    if (!group.scope.startsWith('chain:')) continue;
    const chainId = Number(group.scope.slice('chain:'.length));
    const targets = (index.get(`${group.kind}:${group.ident}`) ?? []).filter(g => g !== group && groups.has(g.key)
      && g.scope !== 'unscoped' && !g.scope.startsWith('chain:')
      && (g.members.some(m => m.chainIds.includes(chainId)) || (chainIdsFor?.(g.scope) ?? []).includes(chainId)));
    if (targets.length === 1) mergeInto(groups, targets[0], group);
  }
}

/**
 * A named mention with no network identity at all (`unscoped`) is the same fork as the one
 * group carrying that name under a network — "Glamsterdam" from an outlet that named no chain
 * otherwise stood as its own entry beside Ethereum's. Two or more candidates stay apart: the
 * name alone cannot say which network's activation it meant.
 */
function mergeUnscoped(groups) {
  const index = byIdentity(groups);
  for (const group of [...groups.values()]) {
    if (group.scope !== 'unscoped' || group.kind !== 'name') continue;
    const targets = (index.get(`name:${group.ident}`) ?? []).filter(g => g !== group && groups.has(g.key) && g.scope !== 'unscoped');
    if (targets.length === 1) mergeInto(groups, targets[0], group);
  }
}

/**
 * Unnamed groups (keyed by height or by instant) on one network that describe the same
 * activation become one: they share a height, or their times are within UNNAMED_MATCH_MS of
 * the cluster's ANCHOR — the earliest time it was seeded with. Anchoring rather than chaining:
 * single linkage strung notices 5h apart into one 30h "fork", while here every member is within
 * six hours of the same instant. Heights still join at any distance, since a shared height is
 * the activation itself. Each cluster then folds into the NAMED group on that network with the
 * same activation: Alchemy never names the Sepolia fork, the EF post names it Glamsterdam. A
 * fold needs one candidate — the exact match if there is one, else the only one in range; two
 * named forks stay apart.
 */
function clusterUnnamed(groups) {
  const earliest = (a) => (a.times.length ? Math.min(...a.times) : Infinity);
  const unnamed = [...groups.values()]
    .filter(g => g.kind !== 'name')
    .map(g => ({ g, a: anchorsOf(g.members) }))
    .sort((x, y) => earliest(x.a) - earliest(y.a));

  const clustersByScope = new Map();
  for (const { g, a } of unnamed) {
    if (!clustersByScope.has(g.scope)) clustersByScope.set(g.scope, []);
    const clusters = clustersByScope.get(g.scope);
    const home = clusters.find(c => anchorDistance(c.anchor, a) !== null);
    if (home) {
      mergeInto(groups, home.g, g);
      for (const b of a.blocks) home.anchor.blocks.add(b);
      if (!home.anchor.times.length && a.times.length) home.anchor.times = [earliest(a)];
    } else {
      clusters.push({ g, anchor: { blocks: new Set(a.blocks), times: a.times.length ? [earliest(a)] : [] } });
    }
  }

  // Named anchors are taken once, before any fold: a fold must not depend on which unnamed
  // cluster happened to fold first.
  const namedByScope = new Map();
  for (const g of groups.values()) {
    if (g.kind !== 'name') continue;
    if (!namedByScope.has(g.scope)) namedByScope.set(g.scope, []);
    namedByScope.get(g.scope).push({ g, a: anchorsOf(g.members) });
  }
  for (const [scope, clusters] of clustersByScope) {
    const named = namedByScope.get(scope) ?? [];
    if (!named.length) continue;
    for (const { g } of clusters) {
      const anchors = anchorsOf(g.members);
      const near = named.map(x => ({ g: x.g, d: anchorDistance(anchors, x.a) })).filter(x => x.d !== null);
      const exact = near.filter(x => x.d === 0);
      const targets = exact.length ? exact : near;
      if (targets.length === 1) mergeInto(groups, targets[0].g, g);
    }
  }
}

/**
 * Named groups on the same chains that activate at the same height or the same second are one
 * activation under several names or network spellings. Live: Hoodi's upgrade on 2026-10-26
 * 17:42:48 stood as five entries (Glamsterdam, Gloas and Amsterdam, each under "ethereum hoodi"
 * and "hoodi"), BSC Chapel's Jenner as two. A date-only claim never joins: two forks a network
 * schedules for the same day are not thereby one. Runs last, so `scopes` from collapseIdentical
 * are combined. The group with the most events keeps its name; the rest become aliases.
 */
function mergeSameActivation(groups) {
  const candidates = [];
  for (const g of groups.values()) {
    if (g.kind !== 'name') continue;
    const chains = [...new Set(g.members.flatMap(m => m.chainIds))].sort((a, b) => a - b);
    if (!chains.length) continue;
    const blocks = new Set();
    const times = new Set();
    for (const m of g.members) {
      const { block, time } = memberAnchor(m);
      if (block !== null) blocks.add(block);
      if (Number.isFinite(time) && !isDateOnly(m.fork.activationAt)) times.add(time);
    }
    if (blocks.size || times.size) candidates.push({ g, chains: chains.join(','), blocks, times });
  }
  // Largest first, so the best-attested group absorbs the others and keeps its name.
  candidates.sort((a, b) => b.g.members.length - a.g.members.length);
  const shares = (x, y) => [...x].some(v => y.has(v));
  for (const target of candidates) {
    if (!groups.has(target.g.key)) continue;
    for (const other of candidates) {
      if (other === target || !groups.has(other.g.key) || other.chains !== target.chains) continue;
      if (!shares(other.blocks, target.blocks) && !shares(other.times, target.times)) continue;
      target.g.scopes = [...new Set([...(target.g.scopes ?? [target.g.scope]), ...(other.g.scopes ?? [other.g.scope])])];
      mergeInto(groups, target.g, other.g);
    }
  }
}

// Events with no URL still need a stable identity for de-duplication and collapsing.
const anonymousIds = new WeakMap();
let anonymousSeq = 0;
function eventIdentity(event) {
  if (typeof event?.url === 'string' && event.url) return `url:${event.url}`;
  if (event?.id != null) return `id:${event.id}`;
  if (!anonymousIds.has(event)) anonymousIds.set(event, `anon:${++anonymousSeq}`);
  return anonymousIds.get(event);
}

/**
 * One window naming several networks used to fan out into identical entries — Nanoreth ×3,
 * "Protocol 29" ×2 — each made of exactly the same events, which inflated byPhase without
 * adding a single independent claim. Groups of the same fork identity whose event sets are
 * identical are one entry listing every network. Groups with any event of their own (Stellar's
 * per-network status posts) stay apart, because then the dates genuinely can differ.
 */
function collapseIdentical(groups) {
  const bySignature = new Map();
  for (const g of [...groups.values()]) {
    // Each event's claim is part of the signature: one post giving Sepolia and Hoodi their own
    // dates under the same fork name shares every event, but its claims differ per network.
    const claims = [...new Set(g.members.map(m => [
      eventIdentity(m.event), m.fork?.activationAt ?? '', m.fork?.activationBlock ?? '', m.fork?.state ?? ''
    ].join('|')))].sort();
    const signature = `${g.kind}:${g.ident}|${claims.join('\n')}`;
    const prior = bySignature.get(signature);
    if (prior) {
      prior.scopes.push(g.scope);
      mergeInto(groups, prior, g);
    } else {
      g.scopes = [g.scope];
      bySignature.set(signature, g);
    }
  }
}

/**
 * The chains a mention attributes to one scope. When the source named the forking network,
 * the post's own chains are about the POSTER: an Arbitrum post on Ethereum's Glamsterdam
 * declares 42161, and attaching that to Ethereum's fork both converted its height with
 * Arbitrum's tip and listed it under `?chainId=42161`. Such a member takes the chains the
 * network name resolves to, and the post's chains only when the post is about that network.
 * With no forking network named, the post's chains are kept and the scope's own resolution is
 * added: a HyperEVM window that declares no chain is still a chain 999 fork.
 */
function memberChainIds({ scope, forkNetwork, named, eventChainIds, chainIdsFor }) {
  if (!forkNetwork) {
    const nameScope = scope !== 'unscoped' && !scope.startsWith('chain:');
    const resolved = nameScope ? (chainIdsFor?.(scope) ?? []) : [];
    return resolved.length ? [...new Set([...eventChainIds, ...resolved])] : eventChainIds;
  }
  const resolved = chainIdsFor?.(scope) ?? [];
  if (resolved.length) return resolved;
  // The post's chains carry no per-network split, so they are reused only when the post names
  // exactly this network: an article about "Ethereum" declaring chain 1 must not lend it to
  // the "Ethereum Sepolia" activation, which is not the mainnet date.
  const aboutNetwork = named.length > 0 && named.every(n => n === scope);
  return aboutNetwork ? eventChainIds : [];
}

/**
 * When a mention was made, for "newest claim wins". The enrichment's own `createdAt` when the
 * feed sends it, else `publishedAt` — never `updatedAt`: QuickNode sets that to the window's
 * START, in the future, which made a weeks-old notice the "newest" claim and fired spurious
 * reschedules. Clamped to `now` so no source can claim to have spoken in the future.
 */
export function observedAtOf(event, now = Date.now()) {
  const created = Date.parse(event?.enrichment?.createdAt ?? '');
  const t = Number.isFinite(created) ? created : Date.parse(event?.publishedAt ?? '');
  return Number.isFinite(t) ? Math.min(t, now) : 0;
}

/** When the source announced it: publication first, enrichment time as the fallback. */
function announcedAtOf(event) {
  const published = Date.parse(event?.publishedAt ?? '');
  return Number.isFinite(published) ? published : Date.parse(event?.enrichment?.createdAt ?? '');
}

const PHASE_ORDER = { [FORK_PHASE.UPCOMING]: 0, [FORK_PHASE.UNSCHEDULED]: 1, [FORK_PHASE.CANCELLED]: 2, [FORK_PHASE.PAST]: 3 };

/** Upcoming soonest first, then unscheduled, then cancelled, then history most recent first. */
export function sortForks(forks) {
  return forks.sort((a, b) => {
    if (PHASE_ORDER[a.phase] !== PHASE_ORDER[b.phase]) return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
    const ta = Date.parse(a.activationAt ?? '') || 0;
    const tb = Date.parse(b.activationAt ?? '') || 0;
    return a.phase === FORK_PHASE.PAST ? tb - ta : ta - tb;
  });
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
 * @returns {Promise<object[]>} forks, soonest upcoming first, then unscheduled, then past. Each
 *   carries `kind` (fork | upgrade, see forkKind); filtering on it is the caller's choice.
 */
export async function buildForks(events = [], { tipFor = null, chainIdsFor = null, now = Date.now(), maxTipLookups = DEFAULT_MAX_TIP_LOOKUPS } = {}) {
  let tipBudget = maxTipLookups;
  const groups = new Map();
  for (const event of events) {
    const raw = event?.enrichment?.fork;
    if (!raw) continue;
    const fork = plausibleFork(raw, announcedAtOf(event));
    const observedAt = observedAtOf(event, now);
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
      groups.get(group.key).members.push({ event, fork, chainIds, scope, observedAt });
    }
  }

  mergeChainScopes(groups, chainIdsFor);
  mergeUnscoped(groups);
  clusterUnnamed(groups);
  collapseIdentical(groups);
  mergeSameActivation(groups);

  const forks = [];
  for (const { key, members, scopes } of groups.values()) {
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
      observedAt: m.observedAt
    }));
    const activation = bestActivation(candidates);
    const state = bestState(members.map(m => ({ state: m.fork.state, observedAt: m.observedAt })));
    const activationPrecision = activation?.precision ?? null;

    const named = members.map(m => m.fork.name).find(Boolean) ?? null;
    // Other names the same activation goes by (mergeSameActivation): Gloas and Amsterdam beside
    // Glamsterdam. Spelling variants of the name itself are not aliases.
    const aliases = [...new Map(members.map(m => m.fork.name).filter(Boolean)
      .filter(n => forkIdentity(n) !== forkIdentity(named)).map(n => [forkIdentity(n), n])).values()];
    const sources = [...new Set(members.map(m => m.event.statusPage?.id).filter(Boolean))];
    const feeds = [...new Set(members.map(m => m.event.feed ?? 'status'))];
    forks.push({
      key,
      name: named,
      ...(aliases.length ? { aliases } : {}),
      // Consensus fork / network upgrade, or an ordinary software update that carried a fork
      // marker. See forkKind for the rule.
      kind: forkKind(members, activation),
      // The network this activation belongs to. Two entries can share a codename and differ
      // here — that is the normal case, not a duplicate.
      network: members[0].scope,
      // Every network this entry covers: more than one only when the same events named them all
      // (collapseIdentical), so no network has evidence of its own.
      networks: [...new Set(scopes ?? [members[0].scope])],
      chains: chainIds,
      activationAt: activation?.at ?? null,
      // How the time was arrived at. A consumer that will not show a guess as a schedule needs
      // this, and the calendar shows only forks whose timing is known at all.
      activationEvidence: activation?.evidence ?? null,
      // `day` when the winning claim named only a date: the day is known, not the instant.
      activationPrecision,
      activationBlock: candidates.map(c => c.block).find(b => b != null) ?? null,
      state,
      phase: forkPhase({ activationAt: activation?.at ?? null, state, activationPrecision }, now),
      // Which status pages reported it — the point of the exercise. More than one means the
      // cross-provider join actually fired.
      sources,
      // Which KINDS of source: status pages, forums, news. A fork only news reported is a
      // claim to attribute, not a schedule the network published.
      feeds,
      events: uniqueEvents(members)
    });
  }

  return sortForks(forks);
}

/**
 * The member events, one per URL (dYdX's upgrade arrived as 8 copies of one post), each
 * carrying the fork as THIS fork read it — with an implausible stated date already dropped —
 * oldest first. Where copies differ, the newest-observed one is kept.
 */
function uniqueEvents(members) {
  const byId = new Map();
  for (const m of members) {
    const id = eventIdentity(m.event);
    const prior = byId.get(id);
    if (prior && prior.observedAt >= m.observedAt) continue;
    byId.set(id, m);
  }
  return [...byId.values()]
    .map(m => (m.fork === m.event.enrichment?.fork ? m.event : { ...m.event, enrichment: { ...m.event.enrichment, fork: m.fork } }))
    .sort((a, b) => (Date.parse(a.publishedAt ?? '') || 0) - (Date.parse(b.publishedAt ?? '') || 0));
}
