import { cachedData } from './cache.js';

function getChainByIdRaw(chainId) {
  if (!cachedData.indexed) return null;
  return cachedData.indexed.byChainId[chainId] || null;
}

function transformChain(chain) {
  if (!chain) return null;

  const transformedChain = {
    chainId: chain.chainId,
    name: chain.name,
    shortName: chain.shortName
  };

  if (chain.theGraph) {
    transformedChain['theGraph-id'] = chain.theGraph.id;
    transformedChain.fullName = chain.theGraph.fullName;
    transformedChain.caip2Id = chain.theGraph.caip2Id;
    if (chain.theGraph.aliases) {
      transformedChain.aliases = chain.theGraph.aliases;
    }
  }

  if (chain.nativeCurrency) transformedChain.nativeCurrency = chain.nativeCurrency;
  if (chain.explorers) transformedChain.explorers = chain.explorers;
  if (chain.infoURL) transformedChain.infoURL = chain.infoURL;
  if (chain.sources) transformedChain.sources = chain.sources;
  if (chain.tags) transformedChain.tags = chain.tags;
  if (chain.status) transformedChain.status = chain.status;
  if (chain.statusReason) transformedChain.statusReason = chain.statusReason;
  if (chain.bridges) transformedChain.bridges = chain.bridges;
  if (chain.l2Beat) transformedChain.l2Beat = chain.l2Beat;
  if (chain.forumUrl) transformedChain.forumUrl = chain.forumUrl;

  return transformedChain;
}

export function getChainById(chainId) {
  return transformChain(getChainByIdRaw(chainId));
}

// Memoize getAllChains() so /chains, /scaling, /stats, etc. can hit the same
// transformed array within one data version without re-running transformChain
// over every entry. Keyed by cachedData.lastUpdated — invalidated automatically
// on loadData(); also invalidated when the cache is hot-merged (e.g.
// indexL2BeatSource adds fields without bumping lastUpdated).
let allChainsCache = { lastUpdated: null, lastL2BeatFetchedAt: null, value: null };

function invalidateAllChainsCacheIfStale() {
  const current = {
    lastUpdated: cachedData.lastUpdated,
    lastL2BeatFetchedAt: cachedData.l2beat?.fetchedAt ?? null
  };
  if (
    allChainsCache.lastUpdated !== current.lastUpdated ||
    allChainsCache.lastL2BeatFetchedAt !== current.lastL2BeatFetchedAt
  ) {
    allChainsCache = { ...current, value: null };
  }
}

export function getAllChains() {
  if (!cachedData.indexed) return [];
  invalidateAllChainsCacheIfStale();
  if (allChainsCache.value === null) {
    allChainsCache.value = cachedData.indexed.all.map(transformChain);
  }
  return allChainsCache.value;
}

// Test-only helper.
export function _resetGetAllChainsCacheForTests() {
  allChainsCache = { lastUpdated: null, lastL2BeatFetchedAt: null, value: null };
}

// Words that describe WHICH network variant the user wants rather than the
// chain's name. "Base mainnet" must find the chain named just "Base" — a raw
// substring match instead returns only "ZKBase Mainnet", which sent the
// assistant (and any API client echoing a user's phrasing) to the wrong chain.
const NETWORK_QUALIFIERS = new Set(['mainnet', 'testnet']);

// Alias terms from the TheGraph networks registry entry attached at index
// time: the graph id ("optimism"), shortName ("Optimism"), and aliases
// ("xdai", "optimism-mainnet"). These carry the community names of renamed
// chains — chain 10 is officially "OP Mainnet" and "optimism" appears
// nowhere in its registry name. Hyphens normalize to spaces so the alias
// "optimism-mainnet" matches the query "optimism mainnet".
const NO_ALIASES = new Set();

export function aliasTerms(chain) {
  const tg = chain.theGraph;
  if (!tg) return NO_ALIASES;
  const terms = new Set();
  for (const t of [tg.id, tg.shortName, ...(Array.isArray(tg.aliases) ? tg.aliases : [])]) {
    if (typeof t !== 'string' || t === '') continue;
    const lower = t.toLowerCase();
    terms.add(lower);
    terms.add(lower.replace(/-/g, ' '));
  }
  return terms;
}

export function searchChains(query) {
  if (!cachedData.indexed) return [];

  const results = [];
  const seen = new Set(); // O(1) dedup — results.some() made this O(n²)
  const push = chainId => {
    if (seen.has(chainId)) return;
    seen.add(chainId);
    results.push(getChainById(chainId));
  };
  const queryLower = query.toLowerCase().trim();

  const parsedChainId = Number.parseInt(query, 10);
  if (!Number.isNaN(parsedChainId) && getChainByIdRaw(parsedChainId)) {
    push(parsedChainId);
  }

  // An exact full-query name match is the best possible hit and ranks first:
  // "OP Mainnet" must return chain 10 before substring lookalikes
  // ("Openpiece Mainnet") that an earlier pass would otherwise surface.
  for (const chain of cachedData.indexed.all) {
    if (chain.name?.toLowerCase() === queryLower || chain.shortName?.toLowerCase() === queryLower) {
      push(chain.chainId);
    }
  }
  // Then exact alias hits ("optimism", "xdai", "optimism mainnet" → their
  // renamed chains) before any substring matching.
  for (const chain of cachedData.indexed.all) {
    if (aliasTerms(chain).has(queryLower)) push(chain.chainId);
  }

  const nameMatches = needle => {
    const hits = [];
    for (const chain of cachedData.indexed.all) {
      if (
        chain.name?.toLowerCase().includes(needle) ||
        chain.shortName?.toLowerCase().includes(needle)
      ) {
        hits.push(chain);
      }
    }
    return hits;
  };

  // Qualifier-aware pass FIRST: "base mainnet" → name-match "base", then keep
  // only mainnets (no Testnet tag) — or only testnets for "... testnet".
  // Exact-name hits go before substring hits so the canonical chain ("Base")
  // outranks lookalikes ("ZKBase Mainnet", "BasedAI").
  const tokens = queryLower.split(/\s+/);
  const qualifiers = tokens.filter(t => NETWORK_QUALIFIERS.has(t));
  const nameTokens = tokens.filter(t => !NETWORK_QUALIFIERS.has(t));
  if (qualifiers.length > 0 && nameTokens.length > 0) {
    const needle = nameTokens.join(' ');
    const wantTestnet = qualifiers.includes('testnet');
    // Renamed chains ("optimism" → OP Mainnet) resolve via alias, still
    // honouring the mainnet/testnet filter.
    for (const chain of cachedData.indexed.all) {
      if (aliasTerms(chain).has(needle) && ((chain.tags || []).includes('Testnet')) === wantTestnet) {
        push(chain.chainId);
      }
    }
    const eligible = nameMatches(needle).filter(
      chain => ((chain.tags || []).includes('Testnet')) === wantTestnet
    );
    for (const chain of eligible.filter(c => c.name?.toLowerCase() === needle || c.shortName?.toLowerCase() === needle)) {
      push(chain.chainId);
    }
    for (const chain of eligible) push(chain.chainId);
  }

  // Plain substring pass (original behavior) — also covers phrases where the
  // qualifier IS part of the name ("ZKBase Mainnet", "Base Sepolia Testnet").
  for (const chain of nameMatches(queryLower)) {
    push(chain.chainId);
  }

  // Dead chains sink below living ones (stable sort keeps the rank order
  // within each group) — "optimism" should not lead with Optimism Kovan.
  return results.sort((a, b) => (a.status === 'deprecated') - (b.status === 'deprecated'));
}

export function countChainsByTag(chains) {
  const totalChains = chains.length;
  let totalTestnets = 0;
  let totalL2s = 0;
  let totalBeacons = 0;
  let totalMainnets = 0;
  // Lifecycle status is orthogonal to tags: chains carry active/incubating/
  // deprecated (or none). Counted in the same pass so /stats can report the
  // active-vs-deprecated split without a second scan.
  const byStatus = {};

  for (const chain of chains) {
    const tags = chain.tags || [];
    const isTestnet = tags.includes('Testnet');
    const isL2 = tags.includes('L2');
    const isBeacon = tags.includes('Beacon');

    if (isTestnet) totalTestnets += 1;
    if (isL2) totalL2s += 1;
    if (isBeacon) totalBeacons += 1;
    if (!isTestnet && !isL2 && !isBeacon) totalMainnets += 1;

    const status = chain.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  const deprecatedChains = byStatus.deprecated || 0;
  return {
    totalChains,
    totalMainnets,
    totalTestnets,
    totalL2s,
    totalBeacons,
    byStatus,
    activeChains: totalChains - deprecatedChains,
    deprecatedChains
  };
}

function extractEndpoints(chain) {
  if (!chain) return null;

  const endpoints = {
    chainId: chain.chainId,
    name: chain.name,
    rpc: chain.rpc || [],
    firehose: [],
    substreams: []
  };

  if (chain.theGraph?.services) {
    if (chain.theGraph.services.firehose) {
      endpoints.firehose = chain.theGraph.services.firehose;
    }
    if (chain.theGraph.services.substreams) {
      endpoints.substreams = chain.theGraph.services.substreams;
    }
  }

  return endpoints;
}

export function getEndpointsById(chainId) {
  return extractEndpoints(getChainByIdRaw(chainId));
}

export function getAllEndpoints() {
  if (!cachedData.indexed) return [];
  return cachedData.indexed.all.map(extractEndpoints);
}

function flattenRpcHealthResults() {
  return Object.entries(cachedData.rpcHealth || {}).flatMap(([chainId, results]) => {
    const numericChainId = Number.parseInt(chainId, 10);
    const chainName = cachedData.indexed?.byChainId?.[numericChainId]?.name ?? `Chain ${chainId}`;

    return (Array.isArray(results) ? results : []).map((result) => ({
      chainId: numericChainId,
      chainName,
      url: result.url,
      status: result.ok ? 'working' : 'failed',
      clientVersion: result.clientVersion ?? null,
      blockNumber: result.blockHeight ?? null,
      latencyMs: result.latencyMs ?? null,
      error: result.error ?? null
    }));
  });
}

export function getRpcMonitoringResults() {
  const results = flattenRpcHealthResults();
  const workingEndpoints = results.filter(result => result.status === 'working').length;
  const failedEndpoints = results.length - workingEndpoints;

  return {
    lastUpdated: cachedData.lastRpcCheck,
    totalEndpoints: results.length,
    testedEndpoints: results.length,
    workingEndpoints,
    failedEndpoints,
    results
  };
}

