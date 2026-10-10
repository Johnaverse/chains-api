import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../util/logger.js';
import { safeExternalUrl } from '../util/publicHost.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = join(__dir, '..', '..', 'data', 'network-research.json');

// Static per-network research (family, node/client repositories, papers, features and
// website corrections), converted once from the network research and verification
// workbook and checked in as data/network-research.json. Only items whose evidence was
// checked or partial, and whose audit was not unresolved, were kept. Never fetched: an
// unreadable file just means no research is attached.
export function loadNetworkResearch(path = DATASET_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const byChainId = new Map();
    for (const entry of Array.isArray(parsed?.networks) ? parsed.networks : []) {
      const chainId = Number(entry?.chainId);
      if (Number.isSafeInteger(chainId) && !byChainId.has(chainId)) byChainId.set(chainId, entry);
    }
    return { updatedAt: parsed?.updatedAt ?? null, byChainId };
  } catch (err) {
    logger.warn({ err: err.message }, 'Network research dataset unavailable');
    return { updatedAt: null, byChainId: new Map() };
  }
}

let dataset = loadNetworkResearch();

/** Test-only: swap the dataset (pass a path, or nothing to reload the checked-in file). */
export function _setNetworkResearchForTests(path) {
  dataset = loadNetworkResearch(path);
}

/** Dataset date and size, for /health and /sources. */
export function getNetworkResearchInfo() {
  return { loaded: dataset.byChainId.size > 0, updatedAt: dataset.updatedAt, networks: dataset.byChainId.size };
}

/**
 * The research block for one chain, or null. Served on single-chain lookups only, so the
 * /chains list (and its in-memory projection) doesn't carry ~1.5MB of repositories,
 * papers and features.
 */
export function getNetworkResearch(chainId) {
  const entry = dataset.byChainId.get(Number(chainId));
  if (!entry) return null;
  const { chainId: _ignored, websiteCorrection: _website, ...research } = entry;
  return { ...research, updatedAt: dataset.updatedAt };
}

const sameUrl = (a, b) => (safeExternalUrl(a)?.href ?? null) === (safeExternalUrl(b)?.href ?? null);

/**
 * Indexer pass: stamp each researched chain with its `family`, and replace `infoURL` where
 * the research corrected the registry website — but only while the registry still lists
 * the website the research replaced, so an upstream fix is never overwritten. A corrected
 * chain gets `infoURLSource: 'research'` and keeps the registry's value (possibly null)
 * as `registryInfoURL`. Idempotent: once corrected, infoURL no longer matches `replaces`.
 */
export function attachNetworkResearch(indexed) {
  if (!indexed?.byChainId) return;
  for (const [chainId, entry] of dataset.byChainId) {
    const chain = indexed.byChainId[chainId];
    if (!chain) continue;
    if (entry.family) chain.family = entry.family;
    const correction = entry.websiteCorrection;
    const registryInfoURL = chain.infoURL ?? null;
    if (correction?.website && sameUrl(registryInfoURL, correction.replaces)) {
      chain.registryInfoURL = registryInfoURL;
      chain.infoURL = correction.website;
      chain.infoURLSource = 'research';
    }
    if (!Array.isArray(chain.sources)) chain.sources = [];
    if (!chain.sources.includes('research')) chain.sources.push('research');
  }
}
