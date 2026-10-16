import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStaticJson } from '../util/staticJson.js';
import { safeExternalUrl } from '../util/publicHost.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = join(__dir, '..', '..', 'data', 'network-research.json');
const FORUMS_PATH = join(__dir, '..', '..', 'data', 'forum-research.json');
const HARDWARE_PATH = join(__dir, '..', '..', 'data', 'node-hardware.json');
const CHANNELS_PATH = join(__dir, '..', '..', 'data', 'channel-research.json');
const REGISTRY_OVERRIDES_PATH = join(__dir, '..', '..', 'data', 'client-registry-overrides.json');
const CLIENT_LINEAGE_PATH = join(__dir, '..', '..', 'data', 'client-lineage.json');

function indexByChainId(parsed) {
  const byChainId = new Map();
  for (const entry of Array.isArray(parsed?.networks) ? parsed.networks : []) {
    const chainId = Number(entry?.chainId);
    if (Number.isSafeInteger(chainId) && !byChainId.has(chainId)) byChainId.set(chainId, entry);
  }
  return { updatedAt: parsed?.updatedAt ?? null, byChainId };
}

// Static per-network research (family, node/client repositories, papers, features and
// website corrections), converted once from the network research and verification
// workbook and checked in as data/network-research.json. Only items whose evidence was
// checked or partial, and whose audit was not unresolved, were kept. Never fetched: an
// unreadable file just means no research is attached.
export function loadNetworkResearch(path = DATASET_PATH) {
  return indexByChainId(readStaticJson(path, 'Network research dataset'));
}

// Forum research, converted from the network forum links export into
// data/forum-research.json: per chain, the discussion boards the research tied to it,
// each with its relationship (official / community-run), scope, access and activity
// state. Only confirmed or qualified records were kept. This is descriptive research,
// separate from data/forums.json — the curated registry that chains-forum-news polls
// and that `forumUrl` comes from — so nothing here is ever fetched by a poller.
export function loadForumResearch(path = FORUMS_PATH) {
  return indexByChainId(readStaticJson(path, 'Forum research dataset'));
}

// Node hardware research, converted from the node hardware requirements export into
// data/node-hardware.json: per chain, documented sizing profiles (a node role at a
// requirement tier, for a client/version, exact-network or project-family scope), each
// a list of requirements in the publisher's own units — the research does no unit
// conversions, and an omitted component means "nothing documented", never zero. The full
// list: every inventory network the research checked — those with no profile keep its
// `status` (not_found / inaccessible), notes and the sources it read — and every profile,
// unresolved ones included (get_node_requirements sorts them last and labels them).
export function loadNodeHardware(path = HARDWARE_PATH) {
  return indexByChainId(readStaticJson(path, 'Node hardware dataset'));
}

// Communication channel research, converted from the network communication channels
// export into data/channel-research.json: per chain, the public Discord / Telegram / X /
// email / other routes a primary project source links, each with its relationship
// (official_operated / officially_endorsed / community_run / uncertain), scope, access and
// invitation state at research time. Only confirmed or qualified records were kept, and
// repurposed destinations dropped. Nothing here was joined or contacted, and nothing is
// ever fetched: it is a discovery list, not proof a channel is active or answered.
export function loadChannelResearch(path = CHANNELS_PATH) {
  return indexByChainId(readStaticJson(path, 'Channel research dataset'));
}

// Curated corrections to the client registry chains-client-feed builds from /repositories
// (data/client-registry-overrides.json, from the one-by-one registry review): per repository
// id, exclude / keep / drop / add network links, a missing url, a role, and whether to poll.
// chains-api only serves them; the feed applies them after every build, so the curation
// lives with the research it corrects instead of in a file the feed maintains. Null when
// the file is missing or has no `repositories` map — the feed then builds uncorrected.
export function loadClientRegistryOverrides(path = REGISTRY_OVERRIDES_PATH) {
  const parsed = readStaticJson(path, 'Client registry overrides');
  return parsed?.repositories && typeof parsed.repositories === 'object' && !Array.isArray(parsed.repositories) ? parsed : null;
}

// Client lineage (data/client-lineage.json): the client families (Geth, OP Geth, Erigon, the OP
// Stack, …) and curated upstream links the feed uses to say which upstream client a repository
// customizes. Served verbatim like the overrides; the feed builds its matchers from it. Null when
// the file is missing or has no `families` list — the feed then shows host-recorded forks only.
export function loadClientLineage(path = CLIENT_LINEAGE_PATH) {
  const parsed = readStaticJson(path, 'Client lineage');
  return Array.isArray(parsed?.families) ? parsed : null;
}

let dataset = loadNetworkResearch();
let forums = loadForumResearch();
let hardware = loadNodeHardware();
let channels = loadChannelResearch();
let registryOverrides = loadClientRegistryOverrides();
let clientLineage = loadClientLineage();

/** Test-only: swap the datasets (pass paths, or nothing to reload the checked-in files). */
export function _setNetworkResearchForTests(path, forumsPath, hardwarePath, channelsPath, overridesPath, lineagePath) {
  dataset = loadNetworkResearch(path);
  forums = loadForumResearch(forumsPath);
  hardware = loadNodeHardware(hardwarePath);
  channels = loadChannelResearch(channelsPath);
  registryOverrides = loadClientRegistryOverrides(overridesPath);
  clientLineage = loadClientLineage(lineagePath);
}

/**
 * Dataset dates and sizes, for /health and /sources. `loaded` is true only when all four
 * checked-in files loaded: a missing or malformed forum, hardware or channel file is a
 * packaging bug that must show, not disappear behind the network research being fine.
 */
export function getNetworkResearchInfo() {
  const researchLoaded = dataset.byChainId.size > 0;
  const forumsLoaded = forums.byChainId.size > 0;
  const hardwareLoaded = hardware.byChainId.size > 0;
  const channelsLoaded = channels.byChainId.size > 0;
  return {
    loaded: researchLoaded && forumsLoaded && hardwareLoaded && channelsLoaded,
    researchLoaded,
    updatedAt: dataset.updatedAt,
    networks: dataset.byChainId.size,
    forumsLoaded,
    forumNetworks: forums.byChainId.size,
    forumsUpdatedAt: forums.updatedAt,
    hardwareLoaded,
    hardwareNetworks: hardware.byChainId.size,
    hardwareUpdatedAt: hardware.updatedAt,
    channelsLoaded,
    channelNetworks: channels.byChainId.size,
    channelsUpdatedAt: channels.updatedAt
  };
}

const hasItems = entry => entry.repositories?.length > 0 || entry.papers?.length > 0 || entry.features?.length > 0;

/**
 * The research block for one chain, or null when there are no research items or hardware
 * research entry (family alone is stamped on the chain itself). Served on single-chain lookups only,
 * so the /chains list (and its in-memory projection) doesn't carry several MB of
 * repositories, papers, features, forums, channels and hardware profiles. A copy: callers may
 * mutate it without touching the datasets.
 */
export function getNetworkResearch(chainId) {
  const id = Number(chainId);
  const entry = dataset.byChainId.get(id);
  const forumEntry = forums.byChainId.get(id);
  const hardwareEntry = hardware.byChainId.get(id);
  const channelEntry = channels.byChainId.get(id);
  const hasResearch = entry != null && hasItems(entry);
  const hasForums = forumEntry?.forums?.length > 0;
  // A researched chain with no profile still has useful status and source context.
  const hasHardware = hardwareEntry != null;
  const hasChannels = channelEntry?.channels?.length > 0;
  if (!hasResearch && !hasForums && !hasHardware && !hasChannels) return null;
  const research = {};
  if (hasResearch) {
    const { chainId: _ignored, websiteCorrection: _website, ...rest } = structuredClone(entry);
    Object.assign(research, rest);
  }
  if (hasForums) {
    research.forums = structuredClone(forumEntry.forums);
    research.forumsCheckedAt = forumEntry.checkedAt ?? forums.updatedAt;
    // The research's own outcome for this network (found / partial), beside the boards it kept.
    research.forumsStatus = forumEntry.status ?? null;
  }
  if (hasChannels) {
    research.channels = structuredClone(channelEntry.channels);
    research.channelsCheckedAt = channelEntry.checkedAt ?? channels.updatedAt;
    // How firmly the channel research tied the venues to this exact network (confirmed /
    // qualified / unresolved), and its outcome (found / partial).
    research.channelsIdentityStatus = channelEntry.identityStatus ?? null;
    research.channelsStatus = channelEntry.status ?? null;
  }
  if (hasHardware) {
    const { chainId: _ignored, name: _name, ...rest } = structuredClone(hardwareEntry);
    research.hardware = {
      ...rest,
      status: rest.status ?? null,
      identityStatus: rest.identityStatus ?? null,
      checkedAt: rest.checkedAt ?? hardware.updatedAt,
      notes: rest.notes ?? null,
      sources: rest.sources ?? [],
      profiles: rest.profiles ?? []
    };
  }
  // The block's date is the date of the dataset that produced its items — never the
  // network research's date for a chain it does not cover.
  research.updatedAt = hasResearch ? dataset.updatedAt
    : hasForums ? forums.updatedAt
      : hasHardware ? hardware.updatedAt
        : channels.updatedAt;
  return research;
}

/**
 * The node hardware research for one chain — possibly with no profile, when the research
 * looked and found nothing publishable — or null when the chain was never researched.
 * Backs the `get_node_requirements` tool: the research block carries the same profiles,
 * but a chain's full detail can run past the assistant's tool-result cap, so setup
 * questions get their own compact lookup. A copy, like getNetworkResearch.
 */
export function getNodeHardware(chainId) {
  const entry = hardware.byChainId.get(Number(chainId));
  if (!entry) return null;
  return {
    status: entry.status ?? null,
    identityStatus: entry.identityStatus ?? null,
    checkedAt: entry.checkedAt ?? hardware.updatedAt,
    updatedAt: hardware.updatedAt,
    notes: entry.notes ?? null,
    sources: structuredClone(entry.sources ?? []),
    profiles: structuredClone(entry.profiles ?? [])
  };
}

/**
 * The raw repository inputs chains-client-feed builds its client registry from: per chain,
 * the research's node/client repositories verbatim, plus the hardware research's sources and
 * the client name, version and evidence of each profile (requirements left out — the feed
 * only links clients to repositories). Only chains with either are listed. The research file
 * carries no names, so `nameFor` fills them from the chain registry. The feed owns the
 * normalisation and linking, so this stays a projection of the checked-in files. `overrides`
 * is the curated correction set, verbatim (see loadClientRegistryOverrides), or null.
 */
export function getRepositoryInputs(nameFor = () => null) {
  const chainIds = new Set([...dataset.byChainId.keys(), ...hardware.byChainId.keys()]);
  const networks = [];
  for (const chainId of [...chainIds].sort((a, b) => a - b)) {
    const research = dataset.byChainId.get(chainId);
    const hw = hardware.byChainId.get(chainId);
    const repositories = structuredClone(research?.repositories ?? []);
    const profiles = (hw?.profiles ?? [])
      // Applicability and verification travel with the link, so an unresolved or historical
      // profile is not read as verified evidence for a client.
      .map(p => ({
        client: p.client ?? null,
        clientVersion: p.clientVersion ?? null,
        scope: p.scope ?? null,
        deployment: p.deployment ?? null,
        verification: p.verification ?? null,
        evidence: structuredClone(p.evidence ?? []),
        // The pages the figures were read from often name the client's repository (a GitHub
        // README): the feed links client names through them too. URLs only, no requirements.
        requirementSources: [...new Set((p.requirements ?? []).map(r => r.source).filter(s => typeof s === 'string' && s))]
      }))
      .filter(p => p.client || p.evidence.length || p.requirementSources.length);
    // access/notes say when a lead is repurposed or unreadable (chain 112's "operator" site is now an exchange).
    const sources = (hw?.sources ?? [])
      .map(s => ({ url: s.url ?? null, title: s.title ?? null, access: s.access ?? null, notes: s.notes ?? null }))
      .filter(s => s.url);
    if (!repositories.length && !profiles.length && !sources.length) continue;
    networks.push({
      chainId,
      name: hw?.name ?? nameFor(chainId) ?? null,
      repositories,
      hardware: { status: hw?.status ?? null, identityStatus: hw?.identityStatus ?? null, sources, profiles }
    });
  }
  return {
    updatedAt: dataset.updatedAt,
    hardwareUpdatedAt: hardware.updatedAt,
    overridesReviewedAt: registryOverrides?.reviewedAt ?? null,
    count: networks.length,
    networks,
    overrides: registryOverrides,
    lineageReviewedAt: clientLineage?.reviewedAt ?? null,
    lineage: clientLineage
  };
}

// A correction with `replaces: null` fills a missing website only; otherwise both sides
// must parse to the same public URL (two unparseable values are not "the same").
function stillListsReplaced(registryInfoURL, replaces) {
  if (replaces == null) return registryInfoURL == null;
  const current = safeExternalUrl(registryInfoURL)?.href;
  return current != null && current === safeExternalUrl(replaces)?.href;
}

function markResearched(chain) {
  if (!Array.isArray(chain.sources)) chain.sources = [];
  if (!chain.sources.includes('research')) chain.sources.push('research');
}

/**
 * Indexer pass: stamp each researched chain with its `family`, and replace `infoURL` where
 * the research corrected the registry website — but only while the registry still lists
 * the website the research replaced, so an upstream fix is never overwritten. A corrected
 * chain gets `infoURLSource: 'research'` and keeps the registry's value (possibly null)
 * as `registryInfoURL`. Chains covered by any of the datasets list 'research' in
 * `sources`. Idempotent: once corrected, infoURL no longer matches `replaces`.
 */
export function attachNetworkResearch(indexed) {
  if (!indexed?.byChainId) return;
  for (const [chainId, entry] of dataset.byChainId) {
    const chain = indexed.byChainId[chainId];
    if (!chain) continue;
    if (entry.family) chain.family = entry.family;
    const correction = entry.websiteCorrection;
    const registryInfoURL = chain.infoURL ?? null;
    if (correction?.website && stillListsReplaced(registryInfoURL, correction.replaces)) {
      chain.registryInfoURL = registryInfoURL;
      chain.infoURL = correction.website;
      chain.infoURLSource = 'research';
    }
    markResearched(chain);
  }
  for (const keys of [forums.byChainId.keys(), hardware.byChainId.keys(), channels.byChainId.keys()]) {
    for (const chainId of keys) {
      const chain = indexed.byChainId[chainId];
      if (chain) markResearched(chain);
    }
  }
}
