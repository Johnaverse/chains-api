import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStaticJson } from '../util/staticJson.js';
import { safeExternalUrl } from '../util/publicHost.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = join(__dir, '..', '..', 'data', 'network-research.json');
const FORUMS_PATH = join(__dir, '..', '..', 'data', 'forum-research.json');
const HARDWARE_PATH = join(__dir, '..', '..', 'data', 'node-hardware.json');

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
// conversions, and an omitted component means "nothing documented", never zero. Only
// confirmed or qualified profiles were kept.
export function loadNodeHardware(path = HARDWARE_PATH) {
  return indexByChainId(readStaticJson(path, 'Node hardware dataset'));
}

let dataset = loadNetworkResearch();
let forums = loadForumResearch();
let hardware = loadNodeHardware();

/** Test-only: swap the datasets (pass paths, or nothing to reload the checked-in files). */
export function _setNetworkResearchForTests(path, forumsPath, hardwarePath) {
  dataset = loadNetworkResearch(path);
  forums = loadForumResearch(forumsPath);
  hardware = loadNodeHardware(hardwarePath);
}

/** Dataset dates and sizes, for /health and /sources. */
export function getNetworkResearchInfo() {
  return {
    loaded: dataset.byChainId.size > 0,
    updatedAt: dataset.updatedAt,
    networks: dataset.byChainId.size,
    forumNetworks: forums.byChainId.size,
    forumsUpdatedAt: forums.updatedAt,
    hardwareNetworks: hardware.byChainId.size,
    hardwareUpdatedAt: hardware.updatedAt
  };
}

const hasItems = entry => entry.repositories?.length > 0 || entry.papers?.length > 0 || entry.features?.length > 0;

/**
 * The research block for one chain, or null when the research found nothing to list for
 * it (family alone is stamped on the chain itself). Served on single-chain lookups only,
 * so the /chains list (and its in-memory projection) doesn't carry several MB of
 * repositories, papers, features, forums and hardware profiles. A copy: callers may
 * mutate it without touching the datasets.
 */
export function getNetworkResearch(chainId) {
  const id = Number(chainId);
  const entry = dataset.byChainId.get(id);
  const forumEntry = forums.byChainId.get(id);
  const hardwareEntry = hardware.byChainId.get(id);
  const hasResearch = entry != null && hasItems(entry);
  const hasForums = forumEntry?.forums?.length > 0;
  const hasHardware = hardwareEntry?.profiles?.length > 0;
  if (!hasResearch && !hasForums && !hasHardware) return null;
  const research = {};
  if (hasResearch) {
    const { chainId: _ignored, websiteCorrection: _website, ...rest } = structuredClone(entry);
    Object.assign(research, rest);
  }
  if (hasForums) {
    research.forums = structuredClone(forumEntry.forums);
    research.forumsCheckedAt = forumEntry.checkedAt ?? forums.updatedAt;
  }
  if (hasHardware) {
    research.hardware = {
      identityStatus: hardwareEntry.identityStatus ?? null,
      checkedAt: hardwareEntry.checkedAt ?? hardware.updatedAt,
      profiles: structuredClone(hardwareEntry.profiles)
    };
  }
  research.updatedAt = dataset.updatedAt;
  return research;
}

/**
 * The node hardware research for one chain, or null when no profile was kept for it.
 * Backs the `get_node_requirements` tool: the research block carries the same profiles,
 * but a chain's full detail can run past the assistant's tool-result cap, so setup
 * questions get their own compact lookup. A copy, like getNetworkResearch.
 */
export function getNodeHardware(chainId) {
  const entry = hardware.byChainId.get(Number(chainId));
  if (!(entry?.profiles?.length > 0)) return null;
  return {
    status: entry.status ?? null,
    identityStatus: entry.identityStatus ?? null,
    checkedAt: entry.checkedAt ?? hardware.updatedAt,
    updatedAt: hardware.updatedAt,
    profiles: structuredClone(entry.profiles)
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
  for (const keys of [forums.byChainId.keys(), hardware.byChainId.keys()]) {
    for (const chainId of keys) {
      const chain = indexed.byChainId[chainId];
      if (chain) markResearched(chain);
    }
  }
}
