import { getClientReleases, ClientFeedNotFoundError, MAX_RELEASE_LIMIT } from '../sources/clientFeed.js';
import { forkIdentity, forkPhase, isDateOnly, FORK_PHASE } from '../domain/forks.js';
import { networkSlug } from '../domain/networkSlug.js';
import { forkAliases } from './timeline.js';
import { searchChains, getChainById, getAllChains } from '../store/queries.js';
import { learnNetworkWords, mentionsTestNetwork, chainOfBareName } from '../domain/networkWords.js';
import { getAllForks } from './forks.js';
import { forkDisplayName } from '../domain/forkNames.js';

/**
 * The latest release of one client repository, answered as the questions an operator asks:
 * which version, does it ship a hard fork, must I upgrade, is it a security release, does it
 * change my flags — and the link to read it.
 *
 * Every answer is three-valued. `null` means the feed cannot say (the release is not classified
 * yet, has no notes, or the feed predates the field), and a consumer must not read it as "no":
 * the same rule the feed's `review` flag exists for.
 */

// One page of a repo's releases. Enough to reach the previous stable release behind a run of
// release candidates, and the latest of each component of a monorepo that releases often.
const PAGE = 100;
const MAX_COMPONENTS = 20;

const FORK_AHEAD = new Set(['scheduled', 'rescheduled']);
// Forks listed per release, at most; the classifier rarely names more than three.
const MAX_FORKS = 10;

/**
 * "https://github.com/o/r", "github.com/o/r/releases", "github:o/r", "o/r" -> "github:o/r" (lowercase).
 * A GitLab URL's project path ends at "/-/"; a subgroup path ("group/sub/repo") is not an
 * owner/repo the feed tracks and is refused rather than read as "group/sub".
 */
export function parseRepo(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  // Bounded before any pattern runs: the MCP tool passes the caller's string through as-is.
  if (!raw || raw.length > 300) return null;
  const url = /^(?:https?:\/\/)?(?:www\.)?(github|gitlab)\.com\/([^?#]*)/i.exec(raw);
  let host;
  let segments;
  if (url) {
    host = url[1];
    // Split, then drop the empty segments a trailing slash leaves (no backtracking pattern on input).
    segments = url[2].split('/-/')[0].split('/');
    while (segments.length && segments[segments.length - 1] === '') segments.pop();
    // GitHub: owner/repo, then anything (releases/tag/v1). GitLab: the project path is all of it.
    if (host.toLowerCase() === 'github') segments = segments.slice(0, 2);
    else if (segments.length > 2) return null;
  } else {
    const prefixed = /^(?:(github|gitlab):)?([^/]+)\/([^/]+)$/i.exec(raw);
    if (!prefixed) return null;
    host = prefixed[1] ?? 'github';
    segments = [prefixed[2], prefixed[3]];
  }
  if (segments.length !== 2) return null;
  const [owner, repo] = [segments[0], segments[1].replace(/\.git$/i, '')];
  if (![owner, repo].every((x) => /^[A-Za-z0-9_.-]+$/.test(x) && !/^\.+$/.test(x))) return null;
  // "github.com/ethereum" is a host and an owner, not an owner and a repo; a GitHub owner has no dots.
  if (/^(?:www\.)?(?:github|gitlab)\.com$/i.test(owner)) return null;
  if (host.toLowerCase() === 'github' && !/^[A-Za-z0-9-]+$/.test(owner)) return null;
  return `${host.toLowerCase()}:${owner}/${repo}`.toLowerCase();
}

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The one chain among `chains` a network name names: the same slug, or the name with its
 * ecosystem in front or "Testnet" behind ("Hoodi" → "Ethereum Hoodi", "Base Sepolia" → "Base
 * Sepolia Testnet"). Client notes name Ethereum's testnets bare, so between "Ethereum Hoodi" and
 * "Status Network Hoodi" the Ethereum one is meant.
 */
/** Whether a chain is a test network: its registry tag, else a test-network word in its name. */
function isTestChain(c) {
  const known = Number.isFinite(c?.chainId) ? getChainById(c.chainId) : null;
  return known ? Boolean(known.tags?.includes('Testnet')) : mentionsTestNetwork(c?.name);
}

function pickChain(slug, chains) {
  // "Mainnet" names the one main network among the release's chains ("Ethereum Mainnet" slugs
  // to "ethereum", so no name rule reaches it).
  if (slug === 'mainnet') {
    const mains = chains.filter((c) => networkSlug(c?.name) && !isTestChain(c));
    return mains.length === 1 ? mains[0] : null;
  }
  // A network named bare is the chain the registry knows by that id or alias ("hoodi" is
  // Ethereum Hoodi's TheGraph id, "chapel" BSC testnet's), not any chain ending in the word.
  const bare = chainOfBareName(slug);
  const isBare = (c) => Boolean(bare) && (c?.chainId === bare.chainId || networkSlug(c?.name) === networkSlug(bare.name));
  // Otherwise the chain's name may put the ecosystem in front or "Testnet" behind. Any other
  // prefix is another network: "Base Sepolia" is not Sepolia.
  const matches = chains.filter((c) => {
    const s = networkSlug(c?.name);
    return s && (s === slug || s.endsWith(`-${slug}`) || s === `${slug}-testnet` || isBare(c));
  });
  // A chain the registry names bare ("Holesky") written with its ecosystem in front ("Ethereum
  // Holesky"): the front word must be another of the release's own chains, a main network.
  if (matches.length === 0) {
    const mains = new Set(chains.filter((c) => !isTestChain(c)).map((c) => networkSlug(c?.name)).filter(Boolean));
    const prefixed = chains.filter((c) => {
      const s = networkSlug(c?.name);
      return s && slug.endsWith(`-${s}`) && mains.has(slug.slice(0, -s.length - 1));
    });
    return prefixed.length === 1 ? prefixed[0] : null;
  }
  if (matches.length === 1) return matches[0];
  const exact = matches.filter((c) => networkSlug(c.name) === slug || isBare(c));
  return exact.length === 1 ? exact[0] : null;
}

/**
 * The chain a fork's network names: the release's own chains first, then the registry for a
 * network they leave out (a release tagged with Holesky that schedules the fork on Hoodi).
 */
function chainOfNetwork(network, chains) {
  const slug = networkSlug(network);
  if (!slug) return null;
  learnNetworkWords(getAllChains());
  const own = pickChain(slug, chains ?? []);
  if (own) return own;
  const hit = pickChain(slug, searchChains(network).filter(Boolean));
  return hit ? { chainId: hit.chainId, name: hit.name } : null;
}

/**
 * One entry per fork and network. Ethereum names a fork per layer and combined — geth's notes
 * say "Amsterdam", Prysm's "Gloas", Erigon's "Glamsterdam" — and the classifier may list the
 * same activation under two of them; the name the fork list resolves them to leads (learned
 * from the feeds, see forkNames.js), the client's own name is kept as `layerName`.
 */
function forksOf(forks, chains, now, knownForks = null) {
  const out = [];
  const byKey = new Map();
  for (const f of forks) {
    const name = f.name ?? null;
    const aliases = forkAliases(name);
    const combined = aliases.length === 1 && aliases[0] !== forkIdentity(name)?.replace(/ hf$/, '') ? aliases[0] : null;
    const chain = f.network ? chainOfNetwork(f.network, chains) : null;
    const entry = {
      name: combined ? (forkDisplayName(combined) ?? titleCase(combined)) : name,
      ...(combined ? { layerName: name } : {}),
      network: chain?.name ?? f.network ?? null,
      ...(chain ? { chainId: chain.chainId } : {}),
      state: typeof f.state === 'string' ? f.state.toLowerCase() : null,
      // `state` is what the notes said when the release came out ("scheduled" stays scheduled
      // after the date passes); `phase` is where the fork stands now.
      phase: null,
      activationAt: f.activationAt ?? null,
      activationBlock: f.activationBlock ?? null,
      ...(f.activationEpoch != null ? { activationEpoch: f.activationEpoch } : {}),
      ...(f.activationTimestamp != null ? { activationTimestamp: f.activationTimestamp } : {})
    };
    const key = `${aliases[0] ?? name}|${chain?.chainId ?? networkSlug(f.network) ?? ''}`;
    const into = byKey.get(key);
    if (!into) {
      byKey.set(key, entry);
      out.push(entry);
      continue;
    }
    // The same activation twice: keep what either entry knows.
    for (const [k, v] of Object.entries(entry)) if (k !== 'layerName' && into[k] == null && v != null) into[k] = v;
  }
  for (const entry of out) {
    // Ethereum-style forks activate at a unix timestamp the notes may give without a date.
    const ts = Number(entry.activationTimestamp);
    const at = entry.activationAt ?? (Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null);
    entry.phase = forkPhase({
      activationAt: at,
      state: entry.state,
      activationPrecision: entry.activationAt && isDateOnly(entry.activationAt) ? 'day' : null
    }, now);
    // "Completed" with no date, height or timestamp is the notes' word alone, and the model
    // misreads it: geth v1.17.8's fixes "related to the already-active Amsterdam fork" made
    // Glamsterdam past while Hoodi's activation was a week away. When the fork list knows this
    // fork on these chains and has it nowhere past, its phase stands instead.
    if (entry.phase === FORK_PHASE.PAST && unverifiedState(entry) && knownForks) {
      const known = knownMatches(entry, chains, knownForks);
      // Notes naming no network for a fork the list knows on several of the release's chains
      // (geth v1.17.8: Amsterdam, past on Sepolia, a week out on Hoodi): one phase is wrong for
      // one of them, so the fork is listed per network, each as the fork list has it.
      const perNetwork = entry.network == null ? perNetworkForks(entry, known, chains) : [];
      if (perNetwork.length > 1) {
        entry.expandTo = perNetwork;
      } else if (known.length && !known.some((k) => k.phase === FORK_PHASE.PAST)) {
        entry.phase = known.some((k) => k.phase === FORK_PHASE.UPCOMING) ? FORK_PHASE.UPCOMING : known[0].phase;
        entry.phaseFrom = 'forks';
      }
    }
  }
  return out.flatMap((entry) => entry.expandTo ?? [entry]);
}

/** One entry per release chain the fork list knows this fork on: its phase and date there. */
function perNetworkForks(entry, known, chains) {
  const best = new Map(); // chainId -> the best-attested fork-list entry on it
  for (const k of known) {
    for (const id of k.chains ?? []) {
      const chain = (chains ?? []).find((c) => c.chainId === id);
      if (!chain) continue;
      const held = best.get(id);
      if (!held || (k.events?.length ?? 0) > (held.k.events?.length ?? 0)) best.set(id, { k, chain });
    }
  }
  return [...best.values()].map(({ k, chain }) => ({
    ...entry,
    network: getChainById(chain.chainId)?.name ?? chain.name ?? null,
    chainId: chain.chainId,
    phase: k.phase,
    activationAt: entry.activationAt ?? k.activationAt ?? null,
    // Phase and date are the fork list's (/forks), not the notes'.
    phaseFrom: 'forks'
  }));
}

/** Fork-list entries for the same fork (any name it goes by) on this entry's chains. */
function knownMatches(entry, chains, knownForks) {
  const ids = new Set([...forkAliases(entry.name), ...forkAliases(entry.layerName)]);
  if (!ids.size) return [];
  const chainIds = entry.chainId != null ? [entry.chainId] : (chains ?? []).map((c) => c.chainId);
  return knownForks.filter((k) => [k.name, ...(k.aliases ?? [])].some((n) => forkAliases(n).some((id) => ids.has(id)))
    && (!chainIds.length || (k.chains ?? []).some((id) => chainIds.includes(id))));
}

/** A release fork whose phase rests on its stated state alone (no date, height or timestamp). */
const unverifiedState = (f) => f && f.activationAt == null && f.activationBlock == null && f.activationTimestamp == null;

/** Whether the classifier has read the release: an enrichment with a class. */
const isClassified = (item) => typeof item.enrichment?.class === 'string';

/** Whether the release ships a fork: true, false, or null when it is not classified yet. */
function hardforkOf(item, now, knownForks = null) {
  const enr = item.enrichment;
  const forks = enr ? (enr.forks?.length ? enr.forks : enr.fork ? [enr.fork] : []) : [];
  const ahead = forks.some((f) => FORK_AHEAD.has(String(f.state ?? '').toLowerCase()));
  // A scheduled fork answers "yes" whatever else is known; "no" needs a classification.
  const included = enr?.class === 'planned_hard_fork' || ahead ? true : (isClassified(item) ? false : null);
  return {
    included,
    forks: forksOf(forks, item.chains, now, knownForks).slice(0, MAX_FORKS),
    // The feed's recall net: wording the model did not confirm. "Possibly", never "no".
    ...(enr?.review ? { review: enr.review } : {})
  };
}

/** One release as the latest-release answer. */
export function describeRelease(item, now = Date.now(), { knownForks = null } = {}) {
  const rel = item.release;
  const enr = item.enrichment;
  return {
    version: rel.version ?? rel.tag,
    tag: rel.tag,
    component: rel.component,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt,
    prerelease: rel.prerelease,
    client: item.source.name,
    hardfork: hardforkOf(item, now, knownForks),
    // Unclassified -> unknown. The normalizer folds a missing flag into false, which is right for a
    // list but would answer "not mandatory" for a release nobody has read; a stated "yes" stands.
    mandatory: rel.mandatory === true ? true : (isClassified(item) ? false : null),
    security: {
      update: rel.security,
      ...(rel.securityEvidence ?? { source: null, scope: null, ids: [], advisories: [], quote: null })
    },
    flags: {
      changed: rel.flagsChanged,
      changes: rel.flagChanges,
      carriedOver: rel.flagChangesCarriedOver
    },
    class: enr?.class ?? null,
    // The model's summary is a few sentences; bounded so one odd record cannot fill an MCP result.
    summary: typeof enr?.summary === 'string' ? enr.summary.slice(0, 600) : null,
    chains: item.chains,
    chainsFrom: item.chainsFrom
  };
}

const brief = (item) => ({
  version: item.release.version ?? item.release.tag,
  tag: item.release.tag,
  component: item.release.component,
  url: item.url,
  publishedAt: item.publishedAt,
  prerelease: item.release.prerelease
});

/**
 * @param {{repo: string, component?: string, includePrerelease?: boolean, now?: number}} options
 * @returns {Promise<object>} the answer; throws ClientFeedNotFoundError when the repo has no releases
 */
export async function getLatestRelease({ repo, component, includePrerelease = false, now = Date.now() } = {}) {
  const repoId = parseRepo(repo);
  if (!repoId) throw new TypeError('repo must be owner/repo, github:owner/repo, gitlab:owner/repo or a GitHub/GitLab URL');
  try {
    return await latestOf(repoId, { component, includePrerelease, now });
  } catch (err) {
    // A bare "owner/repo" means GitHub, but the feed tracks GitLab projects too (tezos/tezos):
    // look there before answering "no releases". A stated host is never second-guessed.
    if (!(err instanceof ClientFeedNotFoundError) || !/^[^/:]+\/[^/:]+$/.test(String(repo).trim())) throw err;
    try {
      return await latestOf(repoId.replace(/^github:/, 'gitlab:'), { component, includePrerelease, now });
    } catch (gitlabErr) {
      if (gitlabErr instanceof ClientFeedNotFoundError) throw err;
      throw gitlabErr;
    }
  }
}

/**
 * The fork list, read when the release names a fork: building it is what teaches which names
 * are one fork (forkNames.js), and an undated "completed" is checked against it.
 */
async function knownForksFor(item) {
  const enr = item.enrichment;
  const forks = enr ? (enr.forks?.length ? enr.forks : enr.fork ? [enr.fork] : []) : [];
  if (!forks.length) return null;
  try {
    return (await getAllForks()).forks;
  } catch {
    return null;
  }
}

async function latestOf(repoId, { component, includePrerelease, now }) {
  const wanted = component ? String(component).toLowerCase() : null;
  const pick = (items) => items.filter((it) => !wanted || (it.release.component ?? '').toLowerCase() === wanted);
  let result = await getClientReleases({ repo: repoId, limit: PAGE });
  let all = pick(result.items);
  // A component that last released 100 releases ago, or a stable release behind 100 candidates,
  // is past the first page: read the deepest one before answering "none".
  if (result.truncated && (!all.length || (!includePrerelease && !all.some((it) => !it.release.prerelease)))) {
    result = await getClientReleases({ repo: repoId, limit: MAX_RELEASE_LIMIT });
    all = pick(result.items);
  }
  if (!all.length) {
    throw new ClientFeedNotFoundError(wanted
      ? `No releases of component "${component}" recorded for ${repoId}`
      : `No releases recorded for ${repoId}`);
  }
  // Newest first from the feed; an undated release sorts last there and stays last here.
  const stable = all.find((it) => !it.release.prerelease) ?? null;
  const latest = includePrerelease ? all[0] : stable;
  // A newer prerelease of the SAME component: an op-batcher RC is not newer than op-node.
  const sameComponent = latest ? all.filter((it) => it.release.component === latest.release.component) : all;
  const newestPre = sameComponent[0]?.release.prerelease ? sameComponent[0] : null;
  // A monorepo (op-node/v…, op-geth/v… in one repo) has no single "latest version": the newest
  // release overall may be any component. List each one's newest so the caller can pick.
  const seen = new Map();
  for (const it of all) {
    if (!includePrerelease && it.release.prerelease) continue;
    const key = it.release.component ?? '';
    if (!seen.has(key)) seen.set(key, it);
  }
  const components = !wanted && seen.size > 1 ? [...seen.values()].slice(0, MAX_COMPONENTS).map(brief) : null;
  return {
    fetchedAt: result.fetchedAt,
    ...(result.stale ? { stale: true } : {}),
    repo: repoId,
    component: wanted ? (latest?.release.component ?? all[0].release.component) : (latest?.release.component ?? null),
    latest: latest ? describeRelease(latest, now, { knownForks: await knownForksFor(latest) }) : null,
    // Only prereleases on record: say so rather than answer "none".
    ...(latest ? {} : { note: 'Only prereleases are recorded for this repository; ask for prereleases (prerelease=true on the API, includePrerelease on MCP) to see the newest one.' }),
    newerPrerelease: !includePrerelease && newestPre && newestPre !== latest ? brief(newestPre) : null,
    ...(components ? { components } : {})
  };
}
