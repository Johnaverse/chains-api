import { attachStatusPages } from '../sources/statusPages.js';
import { attachForums } from '../sources/forums.js';
import { attachNetworkResearch } from '../sources/networkResearch.js';
import { isKnownEolChain } from '../domain/eolChains.js';

/**
 * Build a mapping of network IDs to chain IDs from The Graph data
 */
function buildNetworkIdToChainIdMap(theGraph) {
  const networkIdToChainId = {};

  if (Array.isArray(theGraph?.networks)) {
    theGraph.networks.forEach(network => {
      // Extract chain ID from caip2Id (format: "eip155:1" or "beacon:11155111")
      // Note: only numeric chain IDs are mapped; named beacon chains
      // (e.g. "beacon:mainnet") still add tags via relations.
      if (network.caip2Id) {
        const match = network.caip2Id.match(/^(?:eip155|beacon):(\d+)$/);
        if (match) {
          const chainId = Number.parseInt(match[1], 10);
          networkIdToChainId[network.id] = chainId;
        }
      }
    });
  }

  return networkIdToChainId;
}

function addBeaconTagToTargetChain(indexed, targetChainId) {
  if (targetChainId !== undefined && indexed.byChainId[targetChainId]) {
    if (!indexed.byChainId[targetChainId].tags) {
      indexed.byChainId[targetChainId].tags = [];
    }
    if (!indexed.byChainId[targetChainId].tags.includes('Beacon')) {
      indexed.byChainId[targetChainId].tags.push('Beacon');
    }
  }
}

function getBridgeUrl(bridge) {
  if (typeof bridge === 'string') return bridge;
  return bridge?.url ?? null;
}

function mergeBridges(chain, newBridges) {
  if (!newBridges || !Array.isArray(newBridges)) return;

  if (!chain.bridges) chain.bridges = [];

  const existingBridgeUrls = new Set(
    chain.bridges.map(getBridgeUrl).filter(url => url !== null)
  );

  newBridges.forEach(bridge => {
    const url = getBridgeUrl(bridge);
    if (url && !existingBridgeUrls.has(url)) {
      chain.bridges.push(bridge);
      existingBridgeUrls.add(url);
    }
  });
}

function processL2ParentRelation(chain, indexed, source = 'chains') {
  if (chain.parent?.type !== 'L2' || !chain.parent?.chain) return;

  const match = chain.parent.chain.match(/^eip155-(\d+)$/);
  if (!match) return;

  const chainId = chain.chainId;
  const parentChainId = Number.parseInt(match[1], 10);

  if (!indexed.byChainId[chainId]) return;

  if (!indexed.byChainId[chainId].tags.includes('L2')) {
    indexed.byChainId[chainId].tags.push('L2');
  }

  const existingRelation = indexed.byChainId[chainId].relations.find(
    r => r.kind === 'l2Of' && r.chainId === parentChainId
  );

  if (!existingRelation) {
    indexed.byChainId[chainId].relations.push({
      kind: 'l2Of',
      network: chain.parent.chain,
      chainId: parentChainId,
      source
    });
  }

  mergeBridges(indexed.byChainId[chainId], chain.parent.bridges);
}

function processTestnetParentRelation(chain, indexed, source = 'chains') {
  if (chain.parent?.type !== 'testnet' || !chain.parent?.chain) return;

  const match = chain.parent.chain.match(/^eip155-(\d+)$/);
  if (!match) return;

  const chainId = chain.chainId;
  const mainnetChainId = Number.parseInt(match[1], 10);

  if (!indexed.byChainId[chainId]) return;

  const existingRelation = indexed.byChainId[chainId].relations.find(
    r => r.kind === 'testnetOf' && r.chainId === mainnetChainId
  );

  if (!existingRelation) {
    indexed.byChainId[chainId].relations.push({
      kind: 'testnetOf',
      network: chain.parent.chain,
      chainId: mainnetChainId,
      source
    });
  }
}

/**
 * Merge RPC URLs from a source array into an existing chain's rpc array,
 * deduplicating by URL string.
 */
function mergeRpcUrlsFromArray(existingChain, newRpcUrls) {
  if (!newRpcUrls || !Array.isArray(newRpcUrls)) return;

  if (!existingChain.rpc) existingChain.rpc = [];

  const existingRpcUrls = new Set();
  existingChain.rpc.forEach(rpc => {
    const url = typeof rpc === 'string' ? rpc : rpc.url;
    if (url) existingRpcUrls.add(url);
  });

  newRpcUrls.forEach(rpc => {
    const url = typeof rpc === 'string' ? rpc : rpc.url;
    if (url && !existingRpcUrls.has(url)) {
      existingChain.rpc.push(rpc);
      existingRpcUrls.add(url);
    }
  });
}

function mergeChainlistEntry(chainData, indexed) {
  const chainId = chainData.chainId;

  if (indexed.byChainId[chainId]) {
    mergeRpcUrlsFromArray(indexed.byChainId[chainId], chainData.rpc);

    if (!indexed.byChainId[chainId].sources.includes('chainlist')) {
      indexed.byChainId[chainId].sources.push('chainlist');
    }

    if (chainData.status && !indexed.byChainId[chainId].status) {
      indexed.byChainId[chainId].status = chainData.status;
    }

    if (chainData.slip44 !== undefined && indexed.byChainId[chainId].slip44 === undefined) {
      indexed.byChainId[chainId].slip44 = chainData.slip44;
    }
  } else {
    indexed.byChainId[chainId] = {
      chainId: Number(chainId),
      name: chainData.name,
      rpc: chainData.rpc || [],
      sources: ['chainlist'],
      tags: [],
      relations: [],
      // Status is only stamped when the source states one — "no status" must
      // stay distinguishable from "active" until applyDefaultStatus, so the
      // curated EOL pass knows which chains upstream actually vouched for.
      ...(chainData.status && { status: chainData.status }),
      ...(chainData.slip44 !== undefined && { slip44: chainData.slip44 })
    };
  }

  if (chainData.slip44 === 1 || chainData.isTestnet === true) {
    if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
      indexed.byChainId[chainId].tags.push('Testnet');
    }
  }
}

function extractChainIdFromCaip2Id(caip2Id) {
  if (!caip2Id) return null;
  const match = caip2Id.match(/^eip155:(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function createTheGraphChainEntry(chainId, network) {
  return {
    chainId,
    name: network.fullName || network.shortName || network.id || 'Unknown',
    shortName: network.shortName,
    nativeCurrency: { symbol: network.nativeToken },
    rpc: network.rpcUrls || [],
    explorers: network.explorerUrls || [],
    sources: ['theGraph'],
    tags: [],
    relations: []
    // No status: the registry doesn't state one; applyDefaultStatus fills
    // 'active' at the end, AFTER the curated EOL pass has had first look.
  };
}

function processTheGraphRelation(relation, chainId, indexed, networkIdToChainId) {
  const { kind, network: targetNetworkId } = relation;
  const targetChainId = networkIdToChainId[targetNetworkId];

  const relationData = {
    kind,
    network: targetNetworkId,
    ...(targetChainId !== undefined && { chainId: targetChainId }),
    source: 'theGraph'
  };

  indexed.byChainId[chainId].relations.push(relationData);

  if (kind === 'testnetOf' && !indexed.byChainId[chainId].tags.includes('Testnet')) {
    indexed.byChainId[chainId].tags.push('Testnet');
  } else if (kind === 'l2Of' && !indexed.byChainId[chainId].tags.includes('L2')) {
    indexed.byChainId[chainId].tags.push('L2');
  } else if (kind === 'beaconOf') {
    addBeaconTagToTargetChain(indexed, targetChainId);
  }
}

function createOrMergeTheGraphChain(chainId, network, indexed) {
  if (indexed.byChainId[chainId]) {
    if (!indexed.byChainId[chainId].sources.includes('theGraph')) {
      indexed.byChainId[chainId].sources.push('theGraph');
    }
    mergeRpcUrlsFromArray(indexed.byChainId[chainId], network.rpcUrls);

    if (!indexed.byChainId[chainId].tags) indexed.byChainId[chainId].tags = [];
    if (!indexed.byChainId[chainId].relations) indexed.byChainId[chainId].relations = [];
  } else {
    indexed.byChainId[chainId] = createTheGraphChainEntry(chainId, network);
  }
}

function addTestnetTagIfApplicable(chainId, network, indexed) {
  if (network.networkType === 'testnet') {
    if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
      indexed.byChainId[chainId].tags.push('Testnet');
    }
  }
}

function processTheGraphNetworkRelations(network, chainId, indexed, networkIdToChainId) {
  if (network.relations && Array.isArray(network.relations)) {
    network.relations.forEach(relation => {
      processTheGraphRelation(relation, chainId, indexed, networkIdToChainId);
    });
  }
}

function addTheGraphSpecificData(chainId, network, indexed) {
  indexed.byChainId[chainId].theGraph = {
    id: network.id,
    fullName: network.fullName,
    shortName: network.shortName,
    caip2Id: network.caip2Id,
    aliases: network.aliases,
    networkType: network.networkType,
    services: network.services,
    nativeToken: network.nativeToken
  };
}

function addChainToNameIndex(chainId, network, indexed) {
  const nameLower = (network.fullName || network.shortName || '').toLowerCase();
  if (nameLower && !indexed.byName[nameLower]) {
    indexed.byName[nameLower] = [];
  }
  if (nameLower && !indexed.byName[nameLower].includes(chainId)) {
    indexed.byName[nameLower].push(chainId);
  }
}

function processBeaconChainRelations(network, networkIdToChainId, indexed) {
  if (network.relations && Array.isArray(network.relations)) {
    network.relations.forEach(relation => {
      if (relation.kind === 'beaconOf') {
        const targetChainId = networkIdToChainId[relation.network];
        addBeaconTagToTargetChain(indexed, targetChainId);
      }
    });
  }
}

function processTheGraphNetwork(network, indexed, networkIdToChainId) {
  const chainId = extractChainIdFromCaip2Id(network.caip2Id);
  const isBeaconChain = network.caip2Id?.startsWith('beacon:');

  if (chainId !== null) {
    createOrMergeTheGraphChain(chainId, network, indexed);
    addTestnetTagIfApplicable(chainId, network, indexed);
    processTheGraphNetworkRelations(network, chainId, indexed, networkIdToChainId);
    addTheGraphSpecificData(chainId, network, indexed);
    addChainToNameIndex(chainId, network, indexed);
  } else if (isBeaconChain) {
    processBeaconChainRelations(network, networkIdToChainId, indexed);
  }
}

function indexChainsSource(chains, indexed) {
  if (!Array.isArray(chains)) return;

  chains.forEach(chain => {
    const chainId = chain.chainId;
    if (chainId === undefined) return;

    if (!indexed.byChainId[chainId]) {
      indexed.byChainId[chainId] = {
        chainId,
        name: chain.name,
        shortName: chain.shortName,
        network: chain.network,
        nativeCurrency: chain.nativeCurrency,
        rpc: chain.rpc || [],
        explorers: chain.explorers || [],
        infoURL: chain.infoURL,
        sources: ['chains'],
        tags: [],
        relations: [],
        // Only stamped when upstream states one (see mergeChainlistEntry).
        ...(chain.status && { status: chain.status }),
        ...(chain.slip44 !== undefined && { slip44: chain.slip44 })
      };
    } else {
      if (chain.slip44 !== undefined && indexed.byChainId[chainId].slip44 === undefined) {
        indexed.byChainId[chainId].slip44 = chain.slip44;
      }
      // An upstream status must reach entries another source created first —
      // this branch used to merge only slip44, silently dropping it.
      if (chain.status && !indexed.byChainId[chainId].status) {
        indexed.byChainId[chainId].status = chain.status;
      }
    }

    if (chain.slip44 === 1) {
      if (!indexed.byChainId[chainId].tags.includes('Testnet')) {
        indexed.byChainId[chainId].tags.push('Testnet');
      }
    }

    const nameLower = (chain.name || '').toLowerCase();
    if (!indexed.byName[nameLower]) indexed.byName[nameLower] = [];
    indexed.byName[nameLower].push(chainId);
  });

  chains.forEach(chain => {
    if (chain.chainId !== undefined) {
      processL2ParentRelation(chain, indexed);
      processTestnetParentRelation(chain, indexed);
    }
  });
}

function indexChainlistSource(chainlist, indexed) {
  if (!chainlist || !Array.isArray(chainlist)) return;

  chainlist.forEach(chainData => {
    const chainId = chainData.chainId;
    if (chainId === undefined || chainId === null || Number.isNaN(Number(chainId))) return;
    mergeChainlistEntry(chainData, indexed);
  });

  chainlist.forEach(chainData => {
    const chainId = chainData.chainId;
    if (chainId === undefined || chainId === null || Number.isNaN(Number(chainId))) return;
    if (!indexed.byChainId[chainId]) return;

    processL2ParentRelation(chainData, indexed, 'chainlist');
    processTestnetParentRelation(chainData, indexed, 'chainlist');

    if (chainData.parent?.bridges) {
      mergeBridges(indexed.byChainId[chainId], chainData.parent.bridges);
    }
  });
}

function indexTheGraphSource(theGraph, indexed, networkIdToChainId) {
  if (Array.isArray(theGraph?.networks)) {
    theGraph.networks.forEach(network => {
      processTheGraphNetwork(network, indexed, networkIdToChainId);
    });
  }
}

function attachSlip44Info(slip44, indexed) {
  if (!slip44) return;
  Object.keys(indexed.byChainId).forEach(chainId => {
    const chain = indexed.byChainId[chainId];
    if (chain.slip44 !== undefined && slip44[chain.slip44]) {
      chain.slip44Info = slip44[chain.slip44];
    }
  });
}

function applyDefaultStatus(indexed) {
  Object.keys(indexed.byChainId).forEach(chainId => {
    const chain = indexed.byChainId[chainId];
    if (!chain.status) chain.status = 'active';
  });
}

// The famous dead networks (Ropsten, Goerli, Mumbai, the Kovan/Goerli-era
// L2 testnets…) carry no status in ANY upstream source, so they used to
// default to 'active'. Seed them from the curated list — but never override
// a status a source explicitly stated, so upstream stays authoritative.
function applyCuratedEolStatus(indexed) {
  Object.values(indexed.byChainId).forEach(chain => {
    if (!chain.status && isKnownEolChain(chain)) {
      chain.status = 'deprecated';
      chain.statusReason = 'curated: known end-of-life network';
    }
  });
}

// "Parent EOL → dependents EOL": a chain built on (l2Of) or testing
// (testnetOf) a deprecated chain is itself deprecated, transitively. The
// fixpoint loop handles L3-and-deeper stacks; propagation never runs upward
// (a dead testnet must not kill its mainnet).
//
// Status precedence, weakest to strongest:
//   1. applyDefaultStatus 'active' fill (no one vouched for the chain)
//   2. curated EOL seed — DEFERS to any explicit source status
//   3. explicit source status (chains.json / chainlist)
//   4. propagation — OVERRIDES even an explicit 'active'
// Propagation deliberately outranks upstream: chains.json still says
// 'active' on e.g. Linea Goerli while its Goerli parent is dead — stale
// child statuses are exactly what this pass exists to correct, and the
// rule-17 validation invariant (no active child of a deprecated parent)
// is only satisfiable if propagation wins. Do not add an explicit-status
// exemption here without removing that rule.
function propagateDeprecatedStatus(indexed) {
  const chains = Object.values(indexed.byChainId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const chain of chains) {
      if (chain.status === 'deprecated') continue;
      const deadParent = (chain.relations || []).find(r =>
        (r.kind === 'l2Of' || r.kind === 'testnetOf') &&
        r.chainId !== undefined &&
        indexed.byChainId[r.chainId]?.status === 'deprecated'
      );
      if (deadParent) {
        chain.status = 'deprecated';
        chain.statusReason = `inherited: ${deadParent.kind} chain ${deadParent.chainId} is deprecated`;
        changed = true;
      }
    }
  }
}

function addReverseRelations(indexed) {
  Object.keys(indexed.byChainId).forEach(chainId => {
    const chain = indexed.byChainId[chainId];
    if (!chain.relations || !Array.isArray(chain.relations)) return;

    chain.relations.forEach(relation => {
      if (relation.kind === 'testnetOf' && relation.chainId !== undefined) {
        const mainnetChain = indexed.byChainId[relation.chainId];
        if (mainnetChain) {
          const existing = mainnetChain.relations.find(
            r => r.kind === 'mainnetOf' && r.chainId === Number.parseInt(chainId, 10)
          );
          if (!existing) {
            mainnetChain.relations.push({
              kind: 'mainnetOf',
              network: chain.name || chain.shortName || chainId.toString(),
              chainId: Number.parseInt(chainId, 10),
              source: relation.source
            });
          }
        }
      }

      if (relation.kind === 'l2Of' && relation.chainId !== undefined) {
        const parentChain = indexed.byChainId[relation.chainId];
        if (parentChain) {
          const existing = parentChain.relations.find(
            r => r.kind === 'parentOf' && r.chainId === Number.parseInt(chainId, 10)
          );
          if (!existing) {
            parentChain.relations.push({
              kind: 'parentOf',
              network: chain.name || chain.shortName || chainId.toString(),
              chainId: Number.parseInt(chainId, 10),
              source: relation.source
            });
          }
        }
      }
    });
  });
}

// Tags that this function attaches solely because L2BEAT classified the chain.
// Listed here so the stale-cleanup pass can drop them when a project disappears.
const L2BEAT_DERIVED_TAGS = new Set(['L2', 'ZK', 'Validium', 'Optimium']);

export function indexL2BeatSource(l2beat, indexed) {
  // l2beat itself missing (e.g. data load skipped entirely) → no-op.
  if (!l2beat) return;

  // Normalize project chainIds to numbers up front so all downstream
  // comparisons (Set membership + byChainId lookups) use one type.
  const projects = Array.isArray(l2beat.projects) ? l2beat.projects : [];
  const normalizedProjects = projects
    .map(p => ({ ...p, chainId: Number(p.chainId) }))
    .filter(p => Number.isSafeInteger(p.chainId));
  const freshChainIds = new Set(normalizedProjects.map(p => p.chainId));

  // Stale cleanup: a chain that previously had l2Beat data but isn't in the
  // fresh project list (project removed from L2BEAT, or empty refresh) loses
  // its l2Beat field, the 'l2beat' source, and any L2BEAT-attributable tags.
  // Tag cleanup is conservative — only tags that this function is the sole
  // emitter of are removed.
  for (const chain of Object.values(indexed.byChainId)) {
    if (chain.l2Beat && !freshChainIds.has(chain.chainId)) {
      delete chain.l2Beat;
      if (Array.isArray(chain.sources)) {
        chain.sources = chain.sources.filter(s => s !== 'l2beat');
      }
      if (Array.isArray(chain.tags)) {
        chain.tags = chain.tags.filter(t => !L2BEAT_DERIVED_TAGS.has(t));
      }
    }
  }

  for (const project of normalizedProjects) {
    const chain = indexed.byChainId[project.chainId];
    if (!chain) continue;

    chain.l2Beat = {
      slug: project.slug,
      displayName: project.displayName,
      stage: project.stage,
      category: project.category,
      stack: project.stack,
      daLayer: project.daLayer,
      hostChainId: project.hostChainId,
      purposes: project.purposes ?? [],
      tvs: project.tvs,
      tvsBreakdown: project.tvsBreakdown,
      activity: project.activity,
      links: project.links,
      riskView: project.riskView,
      milestones: project.milestones,
      dataFreshness: l2beat.source,
      fetchedAt: l2beat.fetchedAt
    };

    if (!Array.isArray(chain.tags)) chain.tags = [];
    if (!chain.tags.includes('L2')) chain.tags.push('L2');
    if (project.category === 'ZK Rollup' && !chain.tags.includes('ZK')) {
      chain.tags.push('ZK');
    }
    if (project.category === 'Validium' && !chain.tags.includes('Validium')) {
      chain.tags.push('Validium');
    }
    if (project.category === 'Optimium' && !chain.tags.includes('Optimium')) {
      chain.tags.push('Optimium');
    }

    if (!Array.isArray(chain.sources)) chain.sources = [];
    if (!chain.sources.includes('l2beat')) chain.sources.push('l2beat');
  }
}

export function indexDefiLlamaSource(defillama, indexed) {
  if (!defillama) return;

  const entries = Array.isArray(defillama.chains) ? defillama.chains : [];
  const fresh = new Map();
  for (const entry of entries) {
    const chainId = Number(entry?.chainId);
    if (Number.isSafeInteger(chainId)) fresh.set(chainId, entry);
  }

  for (const chain of Object.values(indexed.byChainId)) {
    if (chain.defillama && !fresh.has(chain.chainId)) {
      delete chain.defillama;
      if (Array.isArray(chain.sources)) chain.sources = chain.sources.filter(s => s !== 'defillama');
    }
  }

  for (const [chainId, entry] of fresh) {
    const chain = indexed.byChainId[chainId];
    if (!chain) continue;
    const { chainId: _ignored, ...metadata } = entry;
    chain.defillama = { ...metadata, dataFreshness: defillama.source, fetchedAt: defillama.fetchedAt };
    if (!Array.isArray(chain.sources)) chain.sources = [];
    if (!chain.sources.includes('defillama')) chain.sources.push('defillama');
  }
}

/**
 * Index all data into a searchable structure.
 */
export function indexData(theGraph, chainlist, chains, slip44, l2beat, defillama = null) {
  const indexed = {
    byChainId: {},
    byName: {},
    all: []
  };

  const networkIdToChainId = buildNetworkIdToChainIdMap(theGraph);

  indexChainsSource(chains, indexed);
  indexChainlistSource(chainlist, indexed);
  indexTheGraphSource(theGraph, indexed, networkIdToChainId);
  attachSlip44Info(slip44, indexed);
  attachStatusPages(indexed);
  attachForums(indexed);
  attachNetworkResearch(indexed);
  // Status resolution order matters: curated EOL seeds (only where no source
  // stated a status) → propagate deprecated to l2Of/testnetOf dependents →
  // default the rest to 'active'.
  applyCuratedEolStatus(indexed);
  propagateDeprecatedStatus(indexed);
  applyDefaultStatus(indexed);
  addReverseRelations(indexed);
  indexL2BeatSource(l2beat, indexed);
  indexDefiLlamaSource(defillama, indexed);

  indexed.all = Object.values(indexed.byChainId);

  return indexed;
}
