import { getForkMentions } from '../sources/forkFeeds.js';
import { getExplorerTip } from '../sources/blockscout.js';
import { buildForks, forkPhase, inferPastForks, sortForks, FORK_PHASE, FORK_KIND, registryScopes, scopeLookups, normalizeForkName, nameWordsOf } from '../domain/forks.js';
import { getAllChains } from '../store/queries.js';
import { getRepositoryChains } from '../sources/networkResearch.js';
import { logger } from '../util/logger.js';
import { learnForkNames } from '../domain/forkNames.js';
import { learnForkWords } from '../domain/forkWords.js';
import { nodeForkMentions, nodeForkScheduleVersion, getNodeForkSchedules, nodeForkPairs } from '../sources/nodeForkSchedule.js';
import { requestForkSources, forkSourceOf, forkSourceVersion } from '../sources/forkSource.js';
import { learnNetworkWords, mentionsTestNetwork, isKindWord, isTestNetworkWord, chainOfBareName } from '../domain/networkWords.js';

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
 * The chainIds a fork's network scope names, from the registry's chain names ("Ethereum
 * Mainnet" → `ethereum` → 1) and the names the networks registry also knows a chain by —
 * `fullName`, `shortName`, `aliases`, the graph id. Chain 999 is "Wanchain Testnet" in the
 * chain list but HyperEVM everywhere a fork notice is written, so name-only indexing lost
 * every HyperEVM fork from `?chainId=999`. Used for every network-named scope, so an Arbitrum
 * post about Ethereum's fork is filed under chain 1, not under Arbitrum. A name more than two
 * chains share is ambiguous and resolves to nothing rather than to a guess.
 */
const MAX_CHAINS_PER_SCOPE = 2;

function chainNames(chain) {
  const names = [chain.name, chain.fullName, chain.shortName, chain['theGraph-id'],
    ...(Array.isArray(chain.aliases) ? chain.aliases : [])];
  return names.filter((n) => typeof n === 'string' && n.trim());
}

function chainResolver(chains) {
  const byScope = new Map();
  const testIds = new Set(chains.filter(isTestChain).map((c) => c.chainId));
  for (const chain of chains) {
    if (!Number.isFinite(chain?.chainId)) continue;
    for (const name of chainNames(chain)) {
      for (const scope of registryScopes(name)) {
        if (!byScope.has(scope)) byScope.set(scope, new Set());
        byScope.get(scope).add(chain.chainId);
      }
    }
  }
  return (scope) => {
    // "mainnet" is The Graph's id for Ethereum, not a name a fork notice means Ethereum by.
    if (BARE_NETWORK.test(scope ?? '')) return [];
    // Most specific first: "ethereum sepolia", then "sepolia" (the registry's name for 11155111).
    // A name that says no test network means the mainnet when both match: "BNB Smart Chain"
    // is indexed for 97 too (its "BNB Smart Chain Testnet" with the qualifier dropped), and
    // BSC's mainnet Pasteur was listed in chain 97's history.
    const wantMain = !mentionsTestNetwork(scope);
    for (const candidate of scopeLookups(scope)) {
      let ids = [...(byScope.get(candidate) ?? [])];
      if (wantMain && ids.some((id) => !testIds.has(id))) ids = ids.filter((id) => !testIds.has(id));
      if (ids.length) return ids.length <= MAX_CHAINS_PER_SCOPE ? ids : [];
    }
    return [];
  };
}

// Words that say what kind of network a scope is, not which one, learned from the registry
// (networkWords.js). A test-network word stays a name word: "Creditcoin Devnet" is told from
// "Creditcoin Testnet", and "Base Sepolia" from "Base", by the word itself.
const kindOnly = (w) => isKindWord(w) && !isTestNetworkWord(w);
// The most chains a client can run and still be one project's (a mainnet, a testnet or two).
const PROJECT_CLIENT_CHAINS = 3;

/**
 * The chains a client release places a fork on when no name did, from its repository's chains.
 * Release notes name networks in their own words: bnb-chain/bsc says "BSC Chapel Testnet" for
 * the chain the registry calls "BNB Smart Chain Testnet" and "chapel", vechain/thor says
 * "VeChainThor", kub-chain/bkc "Bitkub Chain" for "KUB Mainnet". The repository narrows the
 * registry to the handful of chains that client runs, and a dated fork on none of them is lost
 * from every chain's history — so among those the closest is taken rather than none:
 *   1. the chains whose names (or the repository's) carry the most of the network's words, a
 *      word carried when one contains the other ("vechainthor" / "vechain", "bitkub" / "kub");
 *      — the word itself counting over a longer or shorter one ("coston" is Coston, not Coston2),
 *      test-network words included ("Creditcoin3 Devnet" is "Creditcoin Devnet", not "Creditcoin
 *      Testnet"), structural words left out ("Chain", "Network", "EVM": kindWordsOf);
 *   2. among them, the network's kind (test or main), a live network over a deprecated one
 *      ("Tempo Testnet" is Moderato, not Andantino), then the fewest name words the network did
 *      not say ("Metal" is Metal C-Chain, not Metal Tahoe), then the fewest kind words;
 *   3. a release naming no network, or a network none of them is called ("Pacific-1"), is
 *      read by kind alone — only from a project's own client running a few chains;
 * A test-network fork landing on its mainnet ("Algorand Betanet" on Algorand) is accepted as the
 * nearer error. Up to MAX_CHAINS_PER_SCOPE chains left tied on a named network are all kept; more,
 * a tie read by kind alone, or a client many networks run (go-ethereum, Lighthouse) whose notes
 * did not say which, places nothing.
 */
export function repositoryResolver(chains, repoChains) {
  const byId = new Map(chains.filter((c) => Number.isFinite(c?.chainId)).map((c) => [c.chainId, c]));
  const wordsByChain = new Map();
  const wordsFor = (chain) => {
    // "evm-324" is the registry's placeholder for an unnamed chain, not a name.
    if (!wordsByChain.has(chain.chainId)) wordsByChain.set(chain.chainId, [...new Set(chainNames(chain).filter((n) => !/^evm-\d+$/.test(n)).flatMap(nameWordsOf))]);
    return wordsByChain.get(chain.chainId);
  };
  return (repo, scope) => {
    const candidates = (repoChains?.get(repo) ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (!candidates.length) return [];
    const scopeWords = nameWordsOf(scope);
    const words = scopeWords.filter((w) => !kindOnly(w) && !/^\d+$/.test(w));
    const wantTest = Boolean(scope) && mentionsTestNetwork(scope);
    const repoWords = nameWordsOf(repo.replace(/^[a-z]+:/, '')).filter((w) => w.length >= 3);
    // 2 for the word itself, 1 for a word containing it or contained in it.
    const carried = (own, w) => (own.includes(w) ? 2 : own.some((o) => o.length >= 3 && w.length >= 3 && (o.includes(w) || w.includes(o))) ? 1 : 0);
    const scored = candidates.map((chain) => {
      const all = wordsFor(chain);
      const own = all.filter((w) => !kindOnly(w));
      // A test word many ecosystems use ("testnet", "sepolia") counts half: "Boba BNB Testnet" is
      // nearer Boba BNB than Boba Sepolia (alias "boba-testnet").
      const score = (w) => Math.max(carried(own, w), carried(repoWords, w));
      const named = words.reduce((sum, w) => sum + score(w) / (isKindWord(w) ? 2 : 1), 0);
      // Whether a word naming a network, not only a kind of one, matched: "Testnet" or "Fusaka
      // Testnet" says which of go-ethereum's chains no more than no network at all. "Sepolia" is
      // common too, but the registry's id for a network of its own.
      const identified = words.some((w) => (!isKindWord(w) || chainOfBareName(w)) && score(w) > 0);
      // A retired network loses to its live successor ("Tempo Testnet Andantino (Deprecated)").
      const kind = (isTestChain(chain) === wantTest ? 2 : 0) + (chain.status === 'deprecated' ? 0 : 1);
      // Name words the network did not say: "Metal C-Chain" over "Metal Tahoe C-Chain" for "Metal".
      const extra = own.filter((o) => !words.some((w) => carried([o], w))).length;
      // Then the kind words it did not say: "Shibarium" over "Shibarium Beta" (named networks only).
      const extraKind = all.filter((o) => kindOnly(o) && !scopeWords.includes(o)).length;
      return { chain, named, identified, kind, extra, extraKind };
    });
    const pick = (list, by) => { const top = Math.max(...list.map(by)); return list.filter((n) => by(n) === top); };
    const byName = pick(scored, (n) => n.named);
    // Nothing the network says names any of the chains (no network named, or "Pacific-1" for
    // "Sei Network"): only a project's own client — a mainnet and a testnet or two — is narrow
    // enough to read its kind as the answer. A release of go-ethereum or reth naming "Fusaka
    // Devnet-3" is no Sepolia or chain 1 fork.
    const guessing = !scope || !byName.some((n) => n.identified);
    if (guessing && candidates.length > PROJECT_CLIENT_CHAINS) return [];
    const nearest = pick(pick(byName, (n) => n.kind), (n) => -n.extra);
    // Kind words only break a tie on a network that was named: with none named, "Gnosis" is no
    // likelier than "Ethereum Mainnet" for being shorter.
    const best = guessing ? nearest : pick(nearest, (n) => -n.extraKind);
    // A tie on a network that was named is that network listed twice (two 0G Galileo testnets).
    return best.length <= (guessing ? 1 : MAX_CHAINS_PER_SCOPE) ? best.map((n) => n.chain.chainId) : [];
  };
}

function chainNamesLookup(chains) {
  const byId = new Map(chains.filter((c) => Number.isFinite(c?.chainId)).map((c) => [c.chainId, chainNames(c)]));
  return (chainId) => byId.get(chainId) ?? [];
}

// A fork network that is only a qualifier: "Mainnet", "Testnet". Release notes write it
// because the repository already says which network — Forest's notes put Filecoin's Solstice
// on "Mainnet", Heimdall's put Polygon's Lugano there — and as a scope it resolved through the
// registry's graph id for Ethereum (`mainnet`), filing both under chain 1.
const BARE_NETWORK = /^(main ?net|main|test ?net|devnet|l1|l2)$/;
const TEST_QUALIFIER = /^(test ?net|devnet)$/;

function isTestChain(chain) {
  return Array.isArray(chain?.tags) && chain.tags.includes('Testnet');
}

/** Whether a named network is a test network: by its registry tag, else by its name. */
function isTestName(name, byName) {
  const chain = byName.get(normalizeForkName(name)) ?? byName.get(normalizeForkName(name).replace(/ testnet$/, ''));
  return chain ? isTestChain(chain) : mentionsTestNetwork(name);
}

/**
 * A mention whose fork network is a bare qualifier, with the network read from its own chains:
 * the one chain of that kind it names ("Mainnet" + chains 314 and 314159 → "Filecoin -
 * Mainnet"). When none or several qualify, the network is dropped, and with no chain of the
 * stated kind at all the chains go too — Heimdall's "Mainnet" Lugano release names only Amoy,
 * and keeping it would put Polygon mainnet's fork under the testnet.
 */
export function qualifyBareNetwork(mention, byId) {
  const fork = mention?.enrichment?.fork;
  const bare = normalizeForkName(fork?.network ?? '');
  if (!bare || !BARE_NETWORK.test(bare)) return mention;
  const wantTest = TEST_QUALIFIER.test(bare);
  const anyKind = bare === 'l1' || bare === 'l2';
  const ids = [...new Set([...(mention.chains ?? []).map((c) => c.chainId), ...(mention.enrichment.chains ?? [])])];
  const matching = ids.filter((id) => byId.has(id) && (anyKind || isTestChain(byId.get(id)) === wantTest));
  const network = matching.length === 1 ? byId.get(matching[0]).name : null;
  const keepChains = matching.length > 0;
  // The named networks are scopes too (forkScopes), and resolve back to chains: a "Mainnet"
  // fork naming only Amoy would come back as an Amoy fork through them. Same qualifier rule.
  let byName = null;
  const affectedChains = Array.isArray(mention.enrichment.affectedChains) && !anyKind
    ? mention.enrichment.affectedChains.filter((name) => {
      byName ??= new Map([...byId.values()].filter((c) => c?.name).map((c) => [normalizeForkName(c.name).replace(/ testnet$/, ''), c]));
      return typeof name === 'string' && isTestName(name, byName) === wantTest;
    })
    : mention.enrichment.affectedChains;
  return {
    ...mention,
    chains: keepChains ? (mention.chains ?? []).filter((c) => matching.includes(c.chainId)) : [],
    enrichment: {
      ...mention.enrichment,
      chains: keepChains ? (mention.enrichment.chains ?? []).filter((id) => matching.includes(id)) : [],
      ...(affectedChains !== undefined ? { affectedChains } : {}),
      // The qualifier stays for picking among the release's own repository chains, which is
      // not a network name anywhere else.
      fork: { ...fork, network, ...(network ? {} : { qualifier: bare }) }
    }
  };
}

/**
 * buildForks output, kept per (feed snapshot, registry version). The mentions only change when
 * the feed cache refreshes and the resolver only when the registry reloads, and rebuilding on
 * every call cost ~1s of CPU at 1,500 unnamed mentions. Phase depends on the clock, so it is
 * re-derived per call from the memoized activation rather than cached with it.
 */
let memo = { mentions: null, fetchedAt: null, chains: null, repoChains: null, nodeVersion: null, forks: null };

export function _resetForksMemoForTests() {
  memo = { mentions: null, fetchedAt: null, chains: null, repoChains: null, nodeVersion: null, forks: null };
}

async function builtForks(mentions, fetchedAt) {
  const chains = getAllChains();
  const repoChains = getRepositoryChains();
  const nodeVersion = `${nodeForkScheduleVersion()}:${forkSourceVersion()}`;
  if (memo.forks && memo.mentions === mentions && memo.fetchedAt === fetchedAt && memo.chains === chains && memo.repoChains === repoChains && memo.nodeVersion === nodeVersion) return memo.forks;
  // Which words name a test network, or only a kind of network, comes from the registry
  // (networkWords.js); which words of a fork's name are generic, from the feeds (forkWords.js).
  learnNetworkWords(chains);
  learnForkWords(mentions);
  const byId = new Map(chains.map((c) => [c.chainId, c]));
  // Each chain's fork schedule as its nodes hold it (eth_config): a dated fork no feed
  // announced still reaches the chain, and an announced one is confirmed at its instant.
  const nodes = nodeForkMentions({ nameOf: (id) => byId.get(id)?.name ?? null, sourceOf: forkSourceOf });
  const forks = (await buildForks([...mentions.map((m) => qualifyBareNetwork(m, byId)), ...nodes], { tipFor, chainIdsFor: chainResolver(chains), chainNamesFor: chainNamesLookup(chains), repoChainIdsFor: repositoryResolver(chains, repoChains) }))
    .map((fork) => present(fork, unplacedReason(fork, repoChains, byId)));
  // What the feeds show about which names are one fork: read by the timeline and latest release.
  learnForkNames(forks);
  memo = { mentions, fetchedAt, chains, repoChains, nodeVersion, forks };
  return forks;
}

/**
 * Forks assembled from every feed that mentions them: status pages, forums and news.
 *
 * @param {object} [opts]
 * @param {number} [opts.chainId] only forks touching this chain
 * @param {string} [opts.phase] one of upcoming|past|cancelled|unscheduled
 * @param {boolean} [opts.scheduledOnly] drop forks with no known activation time
 * @param {string} [opts.include] `upgrades` to also list ordinary software updates that carried
 *   a fork marker (kind 'upgrade'); excluded by default
 * @param {boolean} [opts.unplaced] only forks on no chain, each with `unplaced` saying why
 * @param {number} [opts.limit]
 */
export async function getForks({ chainId, phase, scheduledOnly = false, include, unplaced = false, limit = DEFAULT_LIMIT } = {}) {
  const { forks, fetchedAt, feeds } = await getAllForks();

  let filtered = forks;
  if (chainId != null) filtered = filtered.filter((f) => f.chains.includes(Number(chainId)));
  // The review queue: forks on no chain, each saying why (unplacedReason).
  if (unplaced) filtered = filtered.filter((f) => f.unplaced);
  // Counted before the kind filter, so a caller sees how many upgrades were left out.
  const byKind = countByKind(filtered);
  // Ordinary software updates that carried a fork marker — 7 of 9 live "forks" were these —
  // are not forks. They stay reachable on request rather than vanishing.
  const includeUpgrades = includesUpgrades(include);
  if (!includeUpgrades) filtered = filtered.filter((f) => f.kind !== FORK_KIND.UPGRADE);
  // Phase counts are taken BEFORE the phase filter. Counting after it makes byPhase describe
  // the filter rather than the world: asked "what forks are coming up", the assistant called
  // get_forks(phase='upcoming'), got byPhase all-zero, and answered "0 total matched across
  // all phases" — while three unscheduled forks existed. A confidently wrong answer, produced
  // by the very field added to stop the model counting rows itself.
  const byPhase = countByPhase(filtered);
  if (phase) filtered = filtered.filter((f) => f.phase === phase);
  // A calendar wants only what can be placed on a day. Separate from `phase` because
  // "upcoming" and "has a date" are genuinely different questions — a fork can be announced
  // and real without anyone having named the day yet.
  if (scheduledOnly) filtered = filtered.filter((f) => f.activationAt !== null);

  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const sliced = filtered.slice(0, capped);
  return {
    // The FEED's fetch time, not ours. loadIncidents serves the last good cache when upstream
    // is down, so stamping "now" would present hours-old forks as freshly fetched — and this
    // is the one field a consumer would use to notice.
    fetchedAt,
    // Per feed, whether it answered. A fork list missing the news feed silently loses every
    // fork only a blog announced, so the gap has to be visible.
    feeds,
    totalMatched: filtered.length,
    count: sliced.length,
    truncated: filtered.length > sliced.length,
    // Counts across everything matched, not just this page: a caller asking "how many upcoming
    // forks" must not have to add up a truncated list.
    byPhase,
    // fork vs upgrade, over everything matched by chain — upgrades included or not.
    byKind,
    upgradesIncluded: includeUpgrades,
    // Forks on no chain, over everything matched: `?unplaced=true` lists them with the reason.
    unplacedCount: filtered.filter((f) => f.unplaced).length,
    forks: sliced
  };
}

/**
 * Every fork entity, unfiltered and uncapped, phase current as of now — for the timeline,
 * which joins provider windows and releases onto them and must see all of them to do it.
 */
// One empty array, so the fork memo still holds across calls during a feed outage.
const NO_FEED_MENTIONS = [];

export async function getAllForks() {
  // Names for the nodes' unnamed forks, from the chains' client code (chains-client-feed
  // /fork-source). Paced and cached there and here; an answer lands in a later build.
  requestForkSources(nodeForkPairs())?.catch?.(() => {});
  let feedRead;
  try {
    feedRead = await getForkMentions();
  } catch (err) {
    // Every feed down before its first answer: the nodes' schedules are an independent source,
    // served alone rather than failing /forks and /timeline with the feeds.
    if (!nodeForkMentions().length) throw err;
    logger.warn({ err: err.message }, 'fork feeds unavailable; serving node fork schedules alone');
    const down = { ok: false, count: 0, filtered: false, oldest: null };
    feedRead = { mentions: NO_FEED_MENTIONS, fetchedAt: null, feeds: { status: down, forum: down, news: down } };
  }
  const { mentions, fetchedAt, feeds: feedStatus } = feedRead;
  const now = Date.now();
  const schedules = [...getNodeForkSchedules().values()];
  // The node schedules read so far: a chain the refresher has not reached, or whose RPCs all
  // refuse eth_config, has none.
  const feeds = { ...feedStatus, node: { ok: true, count: schedules.filter((s) => !s.unsupported).length, unsupported: schedules.filter((s) => s.unsupported).length } };
  // Phases against the clock, then the undated forks a later activation shows to be past.
  // Kept for PHASE_MEMO_MS per build: one profile asks /forks and /timeline, and each used to
  // rerun this pass over every fork.
  const built = await builtForks(mentions, fetchedAt);
  if (phased.built !== built || now - phased.at > PHASE_MEMO_MS) {
    phased.forks = sortForks(inferPastForks(built.map((f) => ({
      ...f,
      phase: forkPhase({ activationAt: f.activationAt, state: f.state, activationPrecision: f.activationPrecision }, now)
    })), now));
    phased.built = built;
    phased.at = now;
  }
  return { forks: phased.forks, fetchedAt, feeds };
}
const PHASE_MEMO_MS = 10000;
const phased = { built: null, at: 0, forks: null };

function includesUpgrades(include) {
  const list = Array.isArray(include) ? include : String(include ?? '').split(',');
  return list.some((v) => String(v).trim() === 'upgrades');
}

function countByKind(forks) {
  const counts = Object.fromEntries(Object.values(FORK_KIND).map((k) => [k, 0]));
  for (const fork of forks) counts[fork.kind] = (counts[fork.kind] ?? 0) + 1;
  return counts;
}

/**
 * The wire shape of a fork.
 *
 * Member events are COMPACTED. buildForks attaches each contributing event whole, which is
 * right for the domain but wrong on the wire: measured at 2210 bytes per fork, a 50-fork page
 * is ~107 KB, and the MCP surface pretty-prints it to ~250 KB. The assistant truncates tool
 * results at 8000 chars, so it would see two forks under a header reading `count: 50,
 * truncated: false` — the "model loses track of totals" failure the sizing convention exists to
 * prevent. Same `compact` shape as the upgrade timeline uses for its related items.
 *
 * `publishedMs` in particular must not survive: it is an internal sort key, and
 * handleGetLiveIncidents already strips it for the same reason.
 */
/**
 * Why a fork is on no chain, for a person to settle: `ambiguous` when the reporting client runs
 * more chains than its notes narrow to (go-ethereum, QuarkChain's shards) — `candidates` lists
 * them; `no_network_named` when nothing says which network; `no_matching_chain` when no registry
 * chain carries the network's name (Stellar and Zcash are in no EVM registry). Null when the fork is placed.
 */
function unplacedReason(fork, repoChains, byId) {
  if (fork.chains?.length) return null;
  const repos = (fork.sources ?? []).filter((s) => /^(github|gitlab):/.test(s)).map((s) => s.toLowerCase());
  const candidates = [...new Set(repos.flatMap((r) => repoChains?.get(r) ?? []))]
    .filter((id) => byId.has(id))
    .map((id) => ({ chainId: id, name: byId.get(id).name ?? null, testnet: isTestChain(byId.get(id)) }));
  const reason = candidates.length ? 'ambiguous' : publicNetwork(fork.network) == null ? 'no_network_named' : 'no_matching_chain';
  return { reason, repositories: repos, candidates };
}

function present(fork, unplaced = null) {
  return {
    ...fork,
    ...(unplaced ? { unplaced } : {}),
    // `unscoped` and `chain:8453` are grouping keys, not network names. Exposing them put an
    // internal identifier in front of a reader who was told this field names the network.
    network: publicNetwork(fork.network),
    networks: (fork.networks ?? [fork.network]).map(publicNetwork).filter(Boolean),
    events: fork.events.map((e) => ({
      feed: e.feed ?? 'status',
      title: e.title,
      url: e.url,
      publishedAt: e.publishedAt,
      status: e.status,
      provider: e.statusPage?.id ?? null,
      // What the item is about, by the feed's classifier: a client release, a provider's
      // software update, a fork announcement. The timeline groups a fork's events on it.
      class: e.enrichment?.class ?? null,
      // A client release names the version operators run for this fork.
      ...(e.release ? { release: e.release } : {}),
      // What THIS source said the fork's state is: a later release that cancels or reschedules
      // the fork is the one to run, not the one that scheduled it (timeline.js).
      state: e.enrichment?.fork?.state ?? null,
      // What THIS source claimed. The fork's activationAt is the strongest claim; sources can
      // disagree, and a reader checking a date needs to see who said what.
      activationAt: e.enrichment?.fork?.activationAt ?? null,
      // A stated date dropped as implausible (well before the post itself): kept visible so a
      // reader can see what the source said and why it was not used.
      ...(e.enrichment?.fork?.implausibleActivationAt ? { implausibleActivationAt: e.enrichment.fork.implausibleActivationAt } : {}),
      ...(e.enrichment?.lowConfidence ? { lowConfidence: true } : {})
    }))
  };
}

/** A scope key is only a network name when it came from a network name. */
function publicNetwork(scope) {
  if (typeof scope !== 'string') return null;
  return scope === 'unscoped' || scope.startsWith('chain:') ? null : scope;
}

function countByPhase(forks) {
  const counts = Object.fromEntries(Object.values(FORK_PHASE).map((p) => [p, 0]));
  for (const fork of forks) counts[fork.phase] = (counts[fork.phase] ?? 0) + 1;
  return counts;
}
