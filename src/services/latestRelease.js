import { getClientReleases, ClientFeedNotFoundError } from '../sources/clientFeed.js';
import { forkIdentity } from '../domain/forks.js';
import { networkSlug } from '../domain/networkSlug.js';
import { forkAliases } from './timeline.js';
import { searchChains } from '../store/queries.js';

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

/** "https://github.com/o/r", "github.com/o/r/releases", "github:o/r", "o/r" -> "github:o/r" (lowercase). */
export function parseRepo(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  const url = /^(?:https?:\/\/)?(?:www\.)?(github|gitlab)\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(raw);
  const prefixed = /^(?:(github|gitlab):)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(raw);
  const m = url ?? prefixed;
  if (!m) return null;
  const [, host = 'github', owner, repo] = m;
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return `${host.toLowerCase()}:${owner}/${repo}`.toLowerCase();
}

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * The one chain among `chains` a network name names: the same slug, or the name with its
 * ecosystem in front or "Testnet" behind ("Hoodi" → "Ethereum Hoodi", "Base Sepolia" → "Base
 * Sepolia Testnet"). Client notes name Ethereum's testnets bare, so between "Ethereum Hoodi" and
 * "Status Network Hoodi" the Ethereum one is meant.
 */
function pickChain(slug, chains) {
  const matches = chains.filter((c) => {
    const s = networkSlug(c?.name);
    return s && (s === slug || s.endsWith(`-${slug}`) || slug.endsWith(`-${s}`) || s === `${slug}-testnet`);
  });
  if (matches.length <= 1) return matches[0] ?? null;
  const exact = matches.filter((c) => networkSlug(c.name) === slug || networkSlug(c.name) === `ethereum-${slug}`);
  return exact.length === 1 ? exact[0] : null;
}

/**
 * The chain a fork's network names: the release's own chains first, then the registry for a
 * network they leave out (a release tagged with Holesky that schedules the fork on Hoodi).
 */
function chainOfNetwork(network, chains) {
  const slug = networkSlug(network);
  if (!slug) return null;
  const own = pickChain(slug, chains ?? []);
  if (own) return own;
  const hit = pickChain(slug, searchChains(network).filter(Boolean));
  return hit ? { chainId: hit.chainId, name: hit.name } : null;
}

/**
 * One entry per fork and network. Ethereum names a fork per layer and combined — geth's notes
 * say "Amsterdam", Prysm's "Gloas", Erigon's "Glamsterdam" — and the classifier may list the
 * same activation under two of them; the combined name leads, the layer name is kept.
 */
function forksOf(forks, chains) {
  const out = [];
  const byKey = new Map();
  for (const f of forks) {
    const name = f.name ?? null;
    const aliases = forkAliases(name);
    const combined = aliases.length === 1 && aliases[0] !== forkIdentity(name)?.replace(/ hf$/, '') ? aliases[0] : null;
    const chain = f.network ? chainOfNetwork(f.network, chains) : null;
    const entry = {
      name: combined ? titleCase(combined) : name,
      ...(combined ? { layerName: name } : {}),
      network: chain?.name ?? f.network ?? null,
      ...(chain ? { chainId: chain.chainId } : {}),
      state: f.state ?? null,
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
  return out;
}

/** Whether the release ships a fork: true, false, or null when it is not classified yet. */
function hardforkOf(item) {
  const enr = item.enrichment;
  const forks = enr ? (enr.forks?.length ? enr.forks : enr.fork ? [enr.fork] : []) : [];
  const included = enr
    ? enr.class === 'planned_hard_fork' || forks.some((f) => FORK_AHEAD.has(f.state))
    : null;
  return {
    included,
    forks: forksOf(forks, item.chains),
    // The feed's recall net: wording the model did not confirm. "Possibly", never "no".
    ...(enr?.review ? { review: enr.review } : {})
  };
}

/** One release as the latest-release answer. */
export function describeRelease(item) {
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
    hardfork: hardforkOf(item),
    // Unclassified -> unknown. The normalizer folds a missing flag into false, which is right for a
    // list but would answer "not mandatory" for a release nobody has read.
    mandatory: enr ? rel.mandatory === true : null,
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
    summary: enr?.summary ?? null,
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
 * @param {{repo: string, component?: string, includePrerelease?: boolean}} options
 * @returns {Promise<object>} the answer; throws ClientFeedNotFoundError when the repo has no releases
 */
export async function getLatestRelease({ repo, component, includePrerelease = false } = {}) {
  const repoId = parseRepo(repo);
  if (!repoId) throw new TypeError('repo must be owner/repo, github:owner/repo, gitlab:owner/repo or a GitHub/GitLab URL');
  const result = await getClientReleases({ repo: repoId, limit: PAGE });
  const wanted = component ? String(component).toLowerCase() : null;
  const all = result.items.filter((it) => !wanted || (it.release.component ?? '').toLowerCase() === wanted);
  if (!all.length) {
    throw new ClientFeedNotFoundError(wanted
      ? `No releases of component "${component}" recorded for ${repoId}`
      : `No releases recorded for ${repoId}`);
  }
  // Newest first from the feed; an undated release sorts last there and stays last here.
  const stable = all.find((it) => !it.release.prerelease) ?? null;
  const latest = includePrerelease ? all[0] : stable;
  const newestPre = all[0].release.prerelease ? all[0] : null;
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
    latest: latest ? describeRelease(latest) : null,
    // Only prereleases on record: say so rather than answer "none".
    ...(latest ? {} : { note: 'Only prereleases are recorded for this repository; pass includePrerelease=true to see the newest one.' }),
    newerPrerelease: !includePrerelease && newestPre && newestPre !== latest ? brief(newestPre) : null,
    ...(components ? { components } : {})
  };
}
