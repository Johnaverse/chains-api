import { forkIdentity } from '../domain/forks.js';
import { networkSlug } from '../domain/networkSlug.js';
import { normalizeIncidentTitle, followingIncidents, sharesNetwork, ACTIVATION_EVIDENCE, getUpgradeTimeline } from './upgrades.js';
import { getAllForks } from './forks.js';
import { getClientReleases, clientFeedConfigured } from '../sources/clientFeed.js';
import { getWeb3News } from '../sources/web3News.js';
import { getForumNews } from '../sources/forumNews.js';
import { logger } from '../util/logger.js';
import { getChainById } from '../store/queries.js';

/**
 * The event timeline: one entry per real-world event, with everything the feeds say about it
 * grouped under it.
 *
 *   hardfork         a consensus fork / network upgrade (a fork entity, src/domain/forks.js).
 *                    Grouped under it: the client releases that ship it, every provider's
 *                    rollout window for it, the news and forum posts about it, and incidents
 *                    on the network in the day after it activated.
 *   software_update  a client version operators roll out with no fork behind it — "Base
 *                    v1.5.0" — grouping each provider's window for that version and the
 *                    client's own release. Never an incident.
 *   maintenance      a provider window that names no software: infrastructure work.
 *
 * Joins, strongest first, and only ever onto a network the item shares:
 *   1. the same post   a provider window that IS one of the fork's status events
 *   2. the version     a window or release naming a version one of the fork's releases ships
 *   3. the name        a window, release or article naming the fork ("Fusaka", "Jenner")
 * Nothing is joined on time alone: two upgrades on one network in one week are common, and a
 * wrong join would put one network's rollout under another's fork.
 */

export const TIMELINE_TYPES = Object.freeze({ HARDFORK: 'hardfork', SOFTWARE_UPDATE: 'software_update', MAINTENANCE: 'maintenance' });

// A release only becomes an event of its own when it asks operators to act: an urgent fix or
// a mandatory upgrade. Ordinary planned releases — ~200 every two months — would bury the
// timeline; they still appear under the rollout or fork they belong to.
const STANDALONE_RELEASE_CLASSES = new Set(['urgent_software_fix']);
const GROUPED_RELEASE_CLASSES = new Set(['planned_software_update', 'urgent_software_fix', 'planned_hard_fork']);

// An article about a fork precedes it by months (EIPs, testnet dates) and follows it by weeks.
const NEWS_BEFORE_MS = 180 * 24 * 60 * 60 * 1000;
const NEWS_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// Per entry, so one fork that every outlet covered cannot make the payload unbounded.
const MAX_GROUPED = 20;

const URGENCY_RANK = { standard: 0, urgent: 1, mandatory: 2, critical: 2 };

/** "v1.8.1", "1.8.1", "Geth-v1.17.6" → "1.8.1" / "1.17.6"; null when no version. */
export function normalizeVersion(version) {
  const m = /(\d+(?:\.\d+)+(?:[-+][0-9a-z.]+)?)/i.exec(String(version ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// One compiled pattern per fork name: every article and window is tested against every fork.
const namePatterns = new Map();

/** Whether `text` names the fork as a word: "Fusaka" in "Fusaka mainnet date set". */
export function namesFork(text, identity) {
  if (!identity || identity.length < 4 || !text) return false;
  let pattern = namePatterns.get(identity);
  if (!pattern) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s-]+');
    pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i');
    if (namePatterns.size > 5000) namePatterns.clear();
    namePatterns.set(identity, pattern);
  }
  return pattern.test(text);
}

function ms(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
}

function iso(t) {
  return t == null ? null : new Date(t).toISOString();
}

function phaseOf(entry, now) {
  const at = ms(entry.activationAt);
  if (at == null) return entry.completed ? 'past' : 'unscheduled';
  return at > now ? 'upcoming' : 'past';
}

/**
 * @param {object} inputs
 * @param {object[]} inputs.forks presented fork entities (services/forks.js getAllForks)
 * @param {object[]} inputs.upgrades provider windows (services/upgrades.js)
 * @param {object[]} [inputs.incidentGroups] incident groups, for fork fallout
 * @param {object[]} [inputs.releases] normalized client releases WITHOUT a fork (sources/clientFeed.js)
 * @param {object[]} [inputs.news] normalized news items (sources/web3News.js)
 * @param {object[]} [inputs.forum] normalized forum posts (sources/forumNews.js)
 * @param {(chainId:number)=>string|null} [inputs.chainName] registry name, for labels
 * @param {(chainId:number)=>boolean} [inputs.isTestnet] registry testnet tag
 * @param {number} [inputs.now]
 * @returns {object[]} entries: upcoming soonest first, then unscheduled, then past newest first
 */
export function buildTimeline({ forks = [], upgrades = [], incidentGroups = [], releases = [], news = [], forum = [], chainName = () => null, isTestnet = () => false, now = Date.now() }) {
  const forkEntries = foldSupportReleases(mergeDuplicateForks(forks.map((fork) => forkEntry(fork))), isTestnet);
  const unmatchedWindows = [];
  for (const window of upgrades) {
    const target = bestFork(forkEntries, window, windowMatch);
    if (target) attachWindow(target, window);
    else unmatchedWindows.push(window);
  }

  // Provider windows that name a version, grouped per version and network across providers.
  const updates = [];
  const maintenance = [];
  for (const window of unmatchedWindows) {
    const versions = windowVersions(window);
    if (!versions.length) { maintenance.push(maintenanceEntry(window, chainName)); continue; }
    const existing = updates.find((u) => u.versions.some((v) => versions.includes(v)) && sharesNetwork(u.chainIds, u.networkSlugs, window.chainIds ?? [], window.networkSlugs ?? []));
    if (existing) attachWindow(existing, window);
    else {
      const entry = updateEntry(window, chainName);
      attachWindow(entry, window);
      updates.push(entry);
    }
  }

  // Client releases with no fork: under the rollout of the same version, under a fork that
  // names it, or — when it asks operators to act — an event of its own.
  for (const release of releases) {
    const cls = release.enrichment?.class ?? null;
    if (!GROUPED_RELEASE_CLASSES.has(cls) && release.release?.mandatory !== true) continue;
    const version = normalizeVersion(release.release?.version ?? release.release?.tag);
    const chainIds = releaseChainIds(release);
    const update = updates.find((u) => version && u.versions.includes(version) && sharesNetwork(u.chainIds, u.networkSlugs, chainIds, []))
      ?? [...forkEntries].find((f) => f.type === TIMELINE_TYPES.SOFTWARE_UPDATE && version && f.versions.includes(version) && sharesNetwork(f.chainIds, f.networkSlugs, chainIds, []))
      ?? bestFork(forkEntries.filter((f) => f.type === TIMELINE_TYPES.HARDFORK), { chainIds, networkSlugs: [], title: `${release.title ?? ''}`, at: ms(release.publishedAt) }, nameMatch);
    if (update) { addRelease(update, release); continue; }
    if (!STANDALONE_RELEASE_CLASSES.has(cls) && release.release?.mandatory !== true) continue;
    const entry = releaseEntry(release, chainIds, version);
    updates.push(entry);
  }

  // Articles and forum posts that name a fork without carrying its fork marker.
  for (const item of [...news.map((n) => ({ ...n, feed: 'news' })), ...forum.map((f) => ({ ...f, feed: 'forum' }))]) {
    const at = ms(item.publishedAt);
    const chainIds = (item.chains ?? []).map((c) => c?.chainId).filter(Number.isFinite);
    const target = bestFork(forkEntries.filter((f) => f.type === TIMELINE_TYPES.HARDFORK), { chainIds, networkSlugs: [], title: item.title, at, allowUnchained: true }, nameMatch);
    if (!target) continue;
    const forkAt = ms(target.activationAt);
    if (forkAt != null && at != null && (at < forkAt - NEWS_BEFORE_MS || at > forkAt + NEWS_AFTER_MS)) continue;
    addNews(target, item);
  }

  const entries = [...forkEntries, ...updates, ...maintenance];
  // Ids are what a client keys rows on, so two rollouts that derive the same one stay apart.
  const seenIds = new Map();
  for (const entry of entries) {
    const n = seenIds.get(entry.id) ?? 0;
    seenIds.set(entry.id, n + 1);
    if (n) entry.id = `${entry.id}#${n + 1}`;
  }
  for (const entry of entries) {
    if (entry.type === TIMELINE_TYPES.HARDFORK) {
      const activationMs = ms(entry.activationAt);
      if (activationMs != null) {
        for (const inc of followingIncidents(incidentGroups, { chainIds: entry.chainIds, slugs: entry.networkSlugs, activationMs, now })) addFallout(entry, inc);
      }
    }
  }
  return entries.map((e) => finish(e, now)).sort((a, b) => compareEntries(a, b));
}

// --- entries -------------------------------------------------------------------------------

// Release notes sometimes put the network in the fork's name slot — "Hoodi", "Sepolia" — for a
// release that adds the network, not a fork. Such an entry is a software update.
const NETWORK_NOT_FORK = new Set(['sepolia', 'hoodi', 'holesky', 'goerli', 'ropsten', 'rinkeby', 'kovan', 'mainnet', 'testnet', 'devnet']);

function forkEntry(fork) {
  const notFork = NETWORK_NOT_FORK.has(forkIdentity(fork.name) ?? '');
  const type = fork.kind === 'upgrade' || notFork ? TIMELINE_TYPES.SOFTWARE_UPDATE : TIMELINE_TYPES.HARDFORK;
  const networks = (fork.networks?.length ? fork.networks : [fork.network]).filter(Boolean);
  const entry = {
    id: `fork:${fork.key}`,
    type,
    name: fork.name ?? null,
    identity: forkIdentity(fork.name),
    title: fork.name ?? fork.events?.[0]?.title ?? 'Unnamed fork',
    url: null,
    network: fork.network ?? null,
    networkNames: networks,
    networkSlugs: networks.map(networkSlug).filter(Boolean),
    chainIds: [...(fork.chains ?? [])],
    activationAt: fork.activationAt ?? null,
    activationEvidence: fork.activationEvidence ?? null,
    activationPrecision: fork.activationPrecision ?? null,
    activationBlock: fork.activationBlock ?? null,
    phase: fork.phase ?? null,
    state: fork.state ?? null,
    completed: fork.state === 'completed',
    urgency: 'standard',
    sources: fork.sources ?? [],
    feeds: fork.feeds ?? [],
    versions: [],
    software: [],
    releases: [],
    providerUpdates: [],
    news: [],
    followedByIncidents: []
  };
  for (const e of fork.events ?? []) {
    if (e.feed === 'release' && e.release) addRelease(entry, { title: e.title, url: e.url, publishedAt: e.publishedAt, release: e.release, enrichment: { class: e.class } });
    else if (e.feed === 'status') addProviderUpdate(entry, { provider: e.provider, title: e.title, url: e.url, status: e.status, activationAt: e.activationAt ?? null, activationEvidence: e.activationAt ? 'stated' : null, urgency: null });
    else addNews(entry, { feed: e.feed, title: e.title, url: e.url, publishedAt: e.publishedAt, source: e.provider });
  }
  // The client team's own release is the primary link, then the network's own post.
  entry.url = entry.releases[0]?.url ?? fork.events?.find((e) => e.url)?.url ?? null;
  return entry;
}

function updateEntry(window, chainName) {
  const versions = windowVersions(window);
  const label = chainName(window.chainIds?.[0]) ?? cleanNetworkName(window.networkNames?.[0]);
  const software = (window.software ?? []).filter((s) => s?.version);
  return {
    id: `update:${window.networkSlugs?.[0] ?? window.chainIds?.[0] ?? 'network'}@${versions[0]}`,
    type: TIMELINE_TYPES.SOFTWARE_UPDATE,
    name: null,
    identity: null,
    title: [label, software.map((s) => [s.client, s.version].filter(Boolean).join(' ')).join(' + ')].filter(Boolean).join(' · ') || window.title,
    url: null,
    network: label,
    networkNames: [],
    networkSlugs: [],
    chainIds: [],
    activationAt: null,
    activationEvidence: null,
    activationPrecision: null,
    activationBlock: null,
    phase: null,
    state: null,
    completed: false,
    urgency: 'standard',
    sources: [],
    feeds: [],
    versions,
    software: [],
    releases: [],
    providerUpdates: [],
    news: [],
    followedByIncidents: []
  };
}

function releaseEntry(release, chainIds, version) {
  const repo = release.release?.repo ?? release.source?.name ?? null;
  const names = (release.chains ?? []).map((c) => c?.name).filter(Boolean);
  const entry = {
    id: `release:${repo}@${version ?? release.release?.tag ?? release.id}`,
    type: TIMELINE_TYPES.SOFTWARE_UPDATE,
    name: null,
    identity: null,
    title: [names.length === 1 ? names[0] : null, [repo, release.release?.version ?? release.release?.tag].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || release.title,
    url: release.url ?? null,
    network: names.length === 1 ? names[0] : null,
    networkNames: names,
    networkSlugs: names.map(networkSlug).filter(Boolean),
    chainIds,
    // A release with no rollout window is "out" when it is published: there is no other time.
    activationAt: release.publishedAt ?? null,
    activationEvidence: 'released',
    activationPrecision: 'time',
    activationBlock: null,
    phase: null,
    state: null,
    completed: true,
    urgency: 'standard',
    sources: [],
    feeds: [],
    versions: version ? [version] : [],
    software: [],
    releases: [],
    providerUpdates: [],
    news: [],
    followedByIncidents: []
  };
  addRelease(entry, release);
  return entry;
}

function maintenanceEntry(window, chainName) {
  const entry = updateEntry(window, chainName);
  entry.id = `window:${window.incidentId ?? `${window.provider}|${normalizeIncidentTitle(window.title)}`}`;
  entry.type = TIMELINE_TYPES.MAINTENANCE;
  entry.title = window.title;
  entry.url = window.url ?? null;
  entry.provider = window.provider ?? null;
  entry.windowMinutes = window.windowMinutes ?? null;
  attachWindow(entry, window);
  return entry;
}

// Ethereum names each fork twice — once per layer — and the combined name besides: geth's
// notes say "Amsterdam", Prysm's "Gloas", Erigon's "Glamsterdam", and all three are one
// activation on one network. Networks that adopt Ethereum's forks (Gnosis, PulseChain) use the
// same names, so the table is about the names, not about chain 1.
const LAYER_NAMES = {
  amsterdam: 'glamsterdam', gloas: 'glamsterdam',
  osaka: 'fusaka', fulu: 'fusaka',
  prague: 'pectra', electra: 'pectra',
  cancun: 'dencun', deneb: 'dencun',
  shanghai: 'shapella', capella: 'shapella',
  paris: 'the merge', bellatrix: 'the merge'
};

/**
 * Every identity a fork name answers to: "nv29 (Solstice)" is nv29 and Solstice,
 * "Glamsterdam/ePBS (Gloas)" is Glamsterdam, ePBS and Gloas — each mapped to its combined
 * Ethereum name where it has one.
 */
export function forkAliases(name) {
  if (typeof name !== 'string') return [];
  const parts = [name, ...name.split(/[()/,;]+/)];
  const ids = new Set();
  for (const part of parts) {
    // "Lugano HF" is Lugano: release titles abbreviate the suffix forkIdentity strips.
    const id = forkIdentity(part)?.replace(/ hf$/, '');
    if (!id) continue;
    ids.add(LAYER_NAMES[id] ?? id);
  }
  return [...ids];
}

/**
 * Fork entries that are one fork under two spellings: "BSC Chapel Testnet" and "BNB Smart
 * Chain Chapel Testnet" both resolve to chain 97; geth's Amsterdam and Prysm's Gloas on
 * Sepolia are one Glamsterdam. Merged only on a shared name AND exactly the same chains — an
 * entry covering mainnet and a testnet is a different activation from the mainnet-only one.
 */
function mergeDuplicateForks(entries) {
  const byKey = new Map();
  const out = [];
  for (const entry of entries) {
    const aliases = forkAliases(entry.name);
    if (!aliases.length || !entry.chainIds.length) { out.push(entry); continue; }
    const chains = [...entry.chainIds].sort((a, b) => a - b).join(',');
    const keys = aliases.map((a) => `${entry.type}|${a}|${chains}`);
    const into = keys.map((k) => byKey.get(k)).find(Boolean);
    if (into) mergeEntry(into, entry);
    else out.push(entry);
    const target = into ?? entry;
    target.aliases = [...new Set([...(target.aliases ?? []), ...aliases])];
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, target);
  }
  for (const entry of out) {
    // The combined name leads when the layers were named separately: "Glamsterdam", not "Gloas".
    const combined = (entry.aliases ?? []).find((a) => Object.values(LAYER_NAMES).includes(a));
    if (combined && forkIdentity(entry.name) !== combined) {
      entry.layerName = entry.name;
      entry.name = combined.replace(/\b[a-z]/g, (c) => c.toUpperCase());
      entry.title = entry.name;
    }
    // Name joins (windows, articles) match any alias, and each layer's own name: a provider
    // window titled "Upgrade for Gloas" belongs to Glamsterdam.
    const names = entry.aliases?.length ? entry.aliases : (entry.identity ? [entry.identity] : []);
    const layers = Object.entries(LAYER_NAMES).filter(([, combined]) => names.includes(combined)).map(([layer]) => layer);
    entry.identities = [...new Set([...names, ...layers])];
  }
  return out;
}

/**
 * A release that ships support for a named fork without dating it — "adds Glamsterdam support",
 * "Etna", "Lugano HF" — is grouped as a software update by the fork rules (no class, height or
 * stated date says fork). Its name says which fork, so it joins that fork's entry: on a shared
 * chain, or, naming none, the one network's activation, or the mainnet one among several.
 * With no such fork in the feeds it stays a software update.
 */
function foldSupportReleases(entries, isTestnet) {
  const forks = entries.filter((e) => e.type === TIMELINE_TYPES.HARDFORK);
  const byAlias = new Map();
  for (const fork of forks) for (const alias of forkAliases(fork.name)) {
    if (!byAlias.has(alias)) byAlias.set(alias, []);
    byAlias.get(alias).push(fork);
  }
  const out = [];
  for (const entry of entries) {
    if (entry.type !== TIMELINE_TYPES.SOFTWARE_UPDATE) { out.push(entry); continue; }
    const candidates = [...new Set(forkAliases(entry.name).flatMap((a) => byAlias.get(a) ?? []))];
    let target = null;
    if (entry.chainIds.length) {
      const sharing = candidates.filter((f) => f.chainIds.some((id) => entry.chainIds.includes(id)));
      if (sharing.length === 1) target = sharing[0];
    } else if (candidates.length === 1) {
      target = candidates[0];
    } else {
      const mainnet = candidates.filter((f) => f.chainIds.length && f.chainIds.every((id) => !isTestnet(id)));
      if (mainnet.length === 1) target = mainnet[0];
    }
    if (!target) { out.push(entry); continue; }
    for (const r of entry.releases) addRelease(target, { title: r.title, url: r.url, publishedAt: r.publishedAt, release: r, enrichment: { class: r.class } });
    for (const p of entry.providerUpdates) addProviderUpdate(target, p);
    for (const n of entry.news) addNews(target, n);
    target.sources = [...new Set([...target.sources, ...entry.sources])];
    target.feeds = [...new Set([...target.feeds, ...entry.feeds])];
  }
  return out;
}

const FORK_EVIDENCE_RANK = { stated: 0, observed: 1, estimated: 2 };

function mergeEntry(into, from) {
  const rank = (e) => (e.activationAt ? (FORK_EVIDENCE_RANK[e.activationEvidence] ?? 3) : 9);
  if (rank(from) < rank(into)) {
    for (const k of ['activationAt', 'activationEvidence', 'activationPrecision', 'phase', 'state']) into[k] = from[k];
  }
  into.activationBlock ??= from.activationBlock;
  into.completed ||= from.completed;
  for (const name of from.networkNames) if (!into.networkNames.includes(name)) into.networkNames.push(name);
  for (const slug of from.networkSlugs) if (!into.networkSlugs.includes(slug)) into.networkSlugs.push(slug);
  into.sources = [...new Set([...into.sources, ...from.sources])];
  into.feeds = [...new Set([...into.feeds, ...from.feeds])];
  for (const r of from.releases) addRelease(into, { title: r.title, url: r.url, publishedAt: r.publishedAt, release: r, enrichment: { class: r.class } });
  for (const p of from.providerUpdates) addProviderUpdate(into, p);
  for (const n of from.news) addNews(into, n);
  into.url ??= from.url;
}

// Providers' network names carry their title decorations: "Urgent Ethereum Mainnet",
// "[Ethereum", "Standard, Fork".
const NAME_DECORATION = /^\s*(?:(?:urgent|standard|critical|mandatory|scheduled|fork|maintenance)\b[\s,:-]*)+/i;

function cleanNetworkName(name) {
  if (typeof name !== 'string') return null;
  const cleaned = name.replace(/[[\]*_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(NAME_DECORATION, '').trim();
  return cleaned || null;
}

// --- joins ---------------------------------------------------------------------------------

function windowVersions(window) {
  return [...new Set((window.software ?? []).map((s) => normalizeVersion(s?.version)).filter(Boolean))];
}

function releaseChainIds(release) {
  // A release attributed to every network its repository serves names none of them.
  if (release.chainsFrom === 'repository' && (release.chains ?? []).length >= 3) return [];
  return (release.chains ?? []).map((c) => c?.chainId).filter(Number.isFinite);
}

/** How strongly a provider window belongs to a fork entry: 3 same post, 2 version, 1 name, 0 none. */
function windowMatch(entry, window) {
  if (!sharesNetwork(entry.chainIds, entry.networkSlugs, window.chainIds ?? [], window.networkSlugs ?? [])) return 0;
  const title = normalizeIncidentTitle(window.title);
  if (entry.providerUpdates.some((p) => p.provider === window.provider && normalizeIncidentTitle(p.title) === title)) return 3;
  const versions = windowVersions(window);
  if (versions.some((v) => entry.versions.includes(v))) return 2;
  return entry.identities?.some((id) => namesFork(window.title, id)) ? 1 : 0;
}

/** A name join for an item that is not a window: a release or an article. */
function nameMatch(entry, item) {
  if (!entry.identities?.some((id) => namesFork(item.title, id))) return 0;
  const chained = item.chainIds.length > 0;
  if (chained) return sharesNetwork(entry.chainIds, entry.networkSlugs, item.chainIds, item.networkSlugs ?? []) ? 1 : 0;
  // An article naming no chain ("Fusaka mainnet date set") is joined only when one entry
  // carries the name — see bestFork.
  return item.allowUnchained ? 1 : 0;
}

/**
 * The fork entry an item belongs to, or null. The strongest join wins; between equal joins,
 * the entry whose activation is nearest the item. An unchained name join that more than one
 * network's entry could claim is left unjoined rather than guessed.
 */
function bestFork(entries, item, score) {
  let best = null;
  let bestScore = 0;
  let tied = [];
  for (const entry of entries) {
    const s = score(entry, item);
    if (!s) continue;
    if (s > bestScore) { best = entry; bestScore = s; tied = [entry]; } else if (s === bestScore) tied.push(entry);
  }
  if (!best || tied.length === 1) return best;
  if (item.allowUnchained && !item.chainIds?.length) {
    const identities = new Set(tied.map((e) => e.identities?.[0] ?? e.identity));
    const networks = new Set(tied.map((e) => e.network));
    if (identities.size > 1 || networks.size > 1) return null;
  }
  const at = item.at ?? ms(item.activationAt);
  if (at == null) return tied[0];
  return tied.reduce((a, b) => (distance(a, at) <= distance(b, at) ? a : b));
}

function distance(entry, at) {
  const t = ms(entry.activationAt);
  return t == null ? Infinity : Math.abs(t - at);
}

// --- grouping --------------------------------------------------------------------------------

function attachWindow(entry, window) {
  addProviderUpdate(entry, {
    provider: window.provider ?? null,
    title: window.title,
    url: window.url ?? null,
    status: window.status ?? null,
    activationAt: window.activationAt ?? null,
    activationEvidence: window.activationEvidence ?? null,
    urgency: window.urgency ?? null,
    windowMinutes: window.windowMinutes ?? null
  });
  for (const s of window.software ?? []) {
    const version = normalizeVersion(s?.version);
    if (version && !entry.versions.includes(version)) entry.versions.push(version);
    if (s?.version && !entry.software.some((x) => x.client === (s.client ?? null) && x.version === s.version)) entry.software.push({ client: s.client ?? null, version: s.version });
  }
  // A rollout's networks join a software update, never a fork: QuickNode's one "Sepolia/Hoodi"
  // window does not make Sepolia's activation a Hoodi one, which is a different day.
  if (entry.type !== TIMELINE_TYPES.HARDFORK) {
    for (const id of window.chainIds ?? []) if (!entry.chainIds.includes(id)) entry.chainIds.push(id);
    for (const slug of window.networkSlugs ?? []) if (!entry.networkSlugs.includes(slug)) entry.networkSlugs.push(slug);
    for (const name of (window.networkNames ?? []).map(cleanNetworkName).filter(Boolean)) if (!entry.networkNames.includes(name)) entry.networkNames.push(name);
  }
  for (const inc of window.followedByIncidents ?? []) addFallout(entry, inc);
  for (const d of window.discussion ?? []) addNews(entry, { ...d, feed: 'forum' });
  for (const c of window.coverage ?? []) addNews(entry, { ...c, feed: 'news' });
  if (window.status === 'maintenance_completed') entry.completed = true;
  if ((URGENCY_RANK[window.urgency] ?? 0) > (URGENCY_RANK[entry.urgency] ?? 0)) entry.urgency = window.urgency;
}

function addProviderUpdate(entry, update) {
  const title = normalizeIncidentTitle(update.title);
  const i = entry.providerUpdates.findIndex((p) => p.provider === update.provider && normalizeIncidentTitle(p.title) === title);
  // The window (with evidence and a duration) replaces the bare status event it came from.
  if (i >= 0) { entry.providerUpdates[i] = { ...entry.providerUpdates[i], ...withoutNulls(update) }; return; }
  entry.providerUpdates.push(update);
}

function addRelease(entry, release) {
  const r = release.release ?? {};
  const version = r.version ?? r.tag ?? null;
  const key = `${r.repo}@${version}`;
  if (entry.releases.some((x) => `${x.repo}@${x.version}` === key)) return;
  entry.releases.push({
    repo: r.repo ?? null,
    version,
    mandatory: r.mandatory === true,
    class: release.enrichment?.class ?? null,
    title: release.title ?? null,
    url: release.url ?? null,
    publishedAt: release.publishedAt ?? null
  });
  const normalized = normalizeVersion(version);
  if (normalized && !entry.versions.includes(normalized)) entry.versions.push(normalized);
  if (r.mandatory === true) entry.urgency = 'mandatory';
}

function addNews(entry, item) {
  if (!item?.url && !item?.title) return;
  const key = (item.url || item.title).toLowerCase();
  if (entry.news.some((n) => (n.url || n.title).toLowerCase() === key)) return;
  entry.news.push({
    feed: item.feed === 'forum' ? 'forum' : 'news',
    source: item.source?.name ?? item.forum?.name ?? (typeof item.source === 'string' ? item.source : null),
    title: item.title ?? null,
    url: item.url ?? null,
    publishedAt: item.publishedAt ?? null
  });
}

function addFallout(entry, inc) {
  const key = inc.url || `${inc.title}|${inc.startedAt}`;
  if (entry.followedByIncidents.some((x) => (x.url || `${x.title}|${x.startedAt}`) === key)) return;
  entry.followedByIncidents.push(inc);
}

function withoutNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
}

// --- output ----------------------------------------------------------------------------------

/** The strongest provider claim to when a rollout runs — the same order /upgrades uses. */
function windowActivation(entry) {
  let best = null;
  for (const p of entry.providerUpdates) {
    const at = ms(p.activationAt);
    const rank = ACTIVATION_EVIDENCE.indexOf(p.activationEvidence);
    if (at == null || rank < 0) continue;
    if (!best || rank < best.rank || (rank === best.rank && at < best.at)) best = { at, rank, evidence: p.activationEvidence };
  }
  return best;
}

function finish(entry, now) {
  if (entry.type !== TIMELINE_TYPES.HARDFORK && entry.activationEvidence !== 'released' && !entry.activationAt) {
    const best = windowActivation(entry);
    if (best) { entry.activationAt = iso(best.at); entry.activationEvidence = best.evidence; entry.activationPrecision = 'time'; }
  }
  if (!entry.phase || entry.type !== TIMELINE_TYPES.HARDFORK) entry.phase = phaseOf(entry, now);
  if (!entry.url) entry.url = entry.releases[0]?.url ?? entry.providerUpdates.find((p) => p.url)?.url ?? null;
  const byTime = (a, b) => (ms(a.publishedAt ?? a.activationAt) ?? 0) - (ms(b.publishedAt ?? b.activationAt) ?? 0);
  const counts = {
    releases: entry.releases.length,
    providerUpdates: entry.providerUpdates.length,
    news: entry.news.length,
    followedByIncidents: entry.followedByIncidents.length
  };
  const providers = [...new Set(entry.providerUpdates.map((p) => p.provider).filter(Boolean))];
  const { identity, identities, aliases, versions, completed, ...rest } = entry;
  return {
    ...rest,
    provider: entry.provider ?? (providers.length === 1 ? providers[0] : null),
    providers,
    counts,
    releases: entry.releases.sort(byTime).slice(0, MAX_GROUPED),
    providerUpdates: entry.providerUpdates.sort(byTime).slice(0, MAX_GROUPED),
    news: entry.news.sort(byTime).slice(-MAX_GROUPED),
    followedByIncidents: entry.followedByIncidents.slice(0, MAX_GROUPED)
  };
}

const PHASE_ORDER = { upcoming: 0, unscheduled: 1, cancelled: 2, past: 3 };

function compareEntries(a, b) {
  const pa = PHASE_ORDER[a.phase] ?? 3;
  const pb = PHASE_ORDER[b.phase] ?? 3;
  if (pa !== pb) return pa - pb;
  const ta = ms(a.activationAt) ?? 0;
  const tb = ms(b.activationAt) ?? 0;
  return pa === 0 ? ta - tb : tb - ta;
}

// --- read side -------------------------------------------------------------------------------

const DEFAULT_LIMIT = 100;
// The dashboard draws every event at once; 750 live ones gzip to ~70 KB.
const MAX_LIMIT = 1000;
// Same cap the sibling news tools use; fork-tagged articles already arrive with the forks, so
// this only finds the recent ones that name a fork without the marker.
const NEWS_LIMIT = 50;
const RELEASE_LIMIT = 500;

// The built timeline, reused for MEMO_TTL_MS. The inputs are rebuilt per call upstream (the fork
// phases and provider windows are re-derived against the clock), so object identity says
// nothing about whether they changed; the feeds behind them refresh once a minute anyway.
const MEMO_TTL_MS = 30_000;
let memo = { at: 0, entries: null };

export function _resetTimelineMemoForTests() {
  memo = { at: 0, entries: null };
}

async function settle(label, promise, fallback) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    logger.warn({ source: label, err: err.message }, 'timeline source unavailable');
    return { ok: false, value: fallback };
  }
}

/**
 * The timeline, filtered. Each source is optional — a feed that is down drops its part and
 * says so in `sources`, rather than failing the whole answer.
 *
 * @param {object} [opts]
 * @param {number} [opts.chainId] only entries touching this chain — its hardfork history
 * @param {string|string[]} [opts.type] hardfork | software_update | maintenance (comma list)
 * @param {string} [opts.phase] upcoming | past | cancelled | unscheduled
 * @param {string} [opts.since] ISO; only entries activating at/after it (drops undated)
 * @param {string} [opts.until] ISO; only entries activating at/before it (drops undated)
 * @param {number} [opts.limit] default 100, max 1000
 */
export async function getTimeline({ chainId, type, phase, since, until, limit = DEFAULT_LIMIT } = {}) {
  const [forks, upgrades, releases, news, forum] = await Promise.all([
    settle('forks', getAllForks(), { forks: [], feeds: {}, fetchedAt: null }),
    settle('upgrades', getUpgradeTimeline(), { upgrades: [], incidentGroups: [] }),
    clientFeedConfigured()
      ? settle('releases', getClientReleases({ fork: false, limit: RELEASE_LIMIT }), { items: [] })
      : Promise.resolve({ ok: false, value: { items: [] }, disabled: true }),
    settle('news', getWeb3News({ limit: NEWS_LIMIT }), { news: [] }),
    settle('forum', getForumNews({ limit: NEWS_LIMIT }), { news: [] })
  ]);
  if (!forks.ok && !upgrades.ok) throw new Error('Timeline sources unavailable: neither the fork feeds nor the status feed answered');

  let entries = memo.entries;
  if (!entries || Date.now() - memo.at >= MEMO_TTL_MS) {
    entries = buildTimeline({
      forks: forks.value.forks,
      upgrades: upgrades.value.upgrades,
      incidentGroups: upgrades.value.incidentGroups,
      releases: releases.value.items ?? [],
      news: news.value.news ?? [],
      forum: forum.value.news ?? [],
      chainName: (id) => (Number.isFinite(id) ? getChainById(id)?.name ?? null : null),
      isTestnet: (id) => Boolean(getChainById(id)?.tags?.includes('Testnet'))
    });
    memo = { at: Date.now(), entries };
  }

  const types = new Set((Array.isArray(type) ? type : String(type ?? '').split(',')).map((t) => String(t).trim()).filter(Boolean));
  const sinceMs = ms(since);
  const untilMs = untilBound(until);
  let filtered = entries;
  if (chainId != null) filtered = filtered.filter((e) => e.chainIds.includes(Number(chainId)));
  if (types.size) filtered = filtered.filter((e) => types.has(e.type));
  // Counted before the phase and date filters, so they describe the chain, not the page.
  const byType = countBy(filtered, 'type', Object.values(TIMELINE_TYPES));
  const byPhase = countBy(filtered, 'phase', ['upcoming', 'unscheduled', 'cancelled', 'past']);
  if (phase) filtered = filtered.filter((e) => e.phase === phase);
  if (sinceMs != null) filtered = filtered.filter((e) => (ms(e.activationAt) ?? -Infinity) >= sinceMs);
  if (untilMs != null) filtered = filtered.filter((e) => (ms(e.activationAt) ?? Infinity) <= untilMs);

  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const sliced = filtered.slice(0, capped);
  return {
    fetchedAt: forks.value.fetchedAt ?? new Date().toISOString(),
    // Which sources answered. A hardfork history missing the release feed is missing most of
    // its past, so the gap has to be visible.
    sources: {
      forks: { ok: forks.ok, feeds: forks.value.feeds ?? {} },
      status: { ok: upgrades.ok },
      releases: { ok: releases.ok, ...(releases.disabled ? { disabled: true } : {}) },
      news: { ok: news.ok },
      forum: { ok: forum.ok }
    },
    totalMatched: filtered.length,
    count: sliced.length,
    truncated: filtered.length > sliced.length,
    byType,
    byPhase,
    entries: sliced
  };
}

/** A bare date includes that whole UTC day, as the feeds read `until`. */
function untilBound(until) {
  if (typeof until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(until.trim())) return ms(`${until.trim()}T23:59:59.999Z`);
  return ms(until);
}

function countBy(list, field, keys) {
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const item of list) counts[item[field]] = (counts[item[field]] ?? 0) + 1;
  return counts;
}
