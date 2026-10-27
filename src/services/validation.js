import { learnNetworkWords, chainOfBareName } from '../domain/networkWords.js';
import { cachedData } from '../store/cache.js';
import { RPC_DEAD_AFTER_MS } from '../../config.js';
import { NO_ANSWER_FAILURES } from '../../rpcUtil.js';
import { getAllChains } from '../store/queries.js';
import { networkTypeClaims, resolveNetworkType, claimsDisagree } from '../domain/networkType.js';

// chainId -> the source's entry, built once per source array. Keyed on the array itself, so a
// reload (a new array) rebuilds it and nothing is ever stale. Every rule looks chains up by id,
// and a linear find per chain per rule made a validation run ~0.7 s of blocked event loop —
// stalling every request that arrived meanwhile (the dashboard loads /metrics at boot).
const sourceIndexes = new WeakMap();
function indexBy(list, idOf) {
  if (!Array.isArray(list)) return null;
  let index = sourceIndexes.get(list);
  if (!index) {
    index = new Map();
    for (const entry of list) {
      const id = idOf(entry);
      // The first entry for an id wins, as Array.find did.
      if (id != null && !index.has(id)) index.set(id, entry);
    }
    sourceIndexes.set(list, index);
  }
  return index;
}
const theGraphChainId = (n) => {
  const match = typeof n?.caip2Id === 'string' ? /^eip155:(\d+)$/.exec(n.caip2Id) : null;
  return match ? Number.parseInt(match[1], 10) : null;
};
const ownChainId = (c) => c?.chainId ?? null;

// A source entry left out of the chain's record because it names another network (rule 20).
function excludedFromRecord(chainId, source) {
  return (cachedData.indexed?.identityConflicts ?? [])
    .some(c => c.chainId === chainId && c.excluded.includes(source));
}

function getChainFromSource(chainId, source) {
  if (excludedFromRecord(chainId, source)) return null;
  if (source === 'theGraph') return indexBy(cachedData.theGraph?.networks, theGraphChainId)?.get(chainId);
  if (source === 'chainlist') return indexBy(cachedData.chainlist, ownChainId)?.get(chainId);
  if (source === 'chains') return indexBy(cachedData.chains, ownChainId)?.get(chainId);
  return null;
}

function validateRule1RelationConflicts(chain, errors) {
  if (!chain.relations || chain.relations.length === 0) return;

  const graphRelations = chain.relations.filter(r => r.source === 'theGraph');

  graphRelations.forEach(graphRel => {
    if (graphRel.kind === 'testnetOf' && graphRel.chainId) {
      if (!chain.tags.includes('Testnet')) {
        errors.push({
          rule: 1,
          chainId: chain.chainId,
          chainName: chain.name,
          type: 'relation_tag_conflict',
          message: `Chain ${chain.chainId} (${chain.name}) has testnetOf relation but is not tagged as Testnet`,
          graphRelation: graphRel
        });
      }
    }

    if (graphRel.kind === 'l2Of' && graphRel.chainId) {
      if (!chain.tags.includes('L2')) {
        errors.push({
          rule: 1,
          chainId: chain.chainId,
          chainName: chain.name,
          type: 'relation_tag_conflict',
          message: `Chain ${chain.chainId} (${chain.name}) has l2Of relation but is not tagged as L2`,
          graphRelation: graphRel
        });
      }
    }
  });
}

// Sources disagree on mainnet vs test network. The tag follows the strongest claim
// (src/domain/networkType.js); every claim is listed with its source and field, so the
// wrong one can be fixed where it was said. `contested` marks a tie at the deciding strength —
// the tag there is a default, not a finding.
function validateRule2NetworkTypeClaims(chain, errors) {
  const claims = networkTypeClaims({
    chains: getChainFromSource(chain.chainId, 'chains'),
    chainlist: getChainFromSource(chain.chainId, 'chainlist'),
    theGraph: getChainFromSource(chain.chainId, 'theGraph')
  });
  if (!claimsDisagree(claims)) return;
  const { isTestnet, decidedBy } = resolveNetworkType(claims);
  const decided = isTestnet ? 'testnet' : 'mainnet';
  const contested = claims.some(c => c.strength === decidedBy.strength && c.value !== decidedBy.value);
  const dissent = claims.filter(c => c.value !== decided);
  errors.push({
    rule: 2,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'network_type_claims_conflict',
    message: `Chain ${chain.chainId} (${chain.name}): treated as ${decided} per ${decidedBy.source} ${decidedBy.field}, but ${dissent.map(c => `${c.source} ${c.field}`).join(', ')} say${dissent.length === 1 ? 's' : ''} otherwise`,
    resolved: decided,
    decidedBy: { source: decidedBy.source, field: decidedBy.field },
    contested,
    claims: claims.map(({ source, field, value, said }) => ({ source, field, value, said }))
  });
}

function validateRule3NameTestnetMismatch(chain, errors) {
  const fullName = chain.theGraph?.fullName || chain.name || '';
  const nameLower = fullName.toLowerCase();

  if ((nameLower.includes('testnet') || nameLower.includes('devnet')) && !chain.tags.includes('Testnet')) {
    errors.push({
      rule: 3,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'name_testnet_mismatch',
      message: `Chain ${chain.chainId} (${chain.name}) has "Testnet" or "Devnet" in full name "${fullName}" but not tagged as Testnet`,
      fullName,
      tags: chain.tags
    });
  }
}

// A chain named after another chain's test network ("Base Sepolia", "Morph Hoodi") is built on or
// for that network and should say so. "Named after" is read from the registry: a word in the name
// that is another testnet's own id or alias ("sepolia" is Ethereum Sepolia's) — never a list of
// names here, and never the generic "testnet", which names no network.
// Plain words for a kind of network, not names of one: a chain aliased "testnet" names no other.
const NETWORK_KIND_WORDS = new Set(['mainnet', 'testnet', 'devnet', 'net', 'network', 'chain']);

function testNetworkNamedIn(chain, fullName) {
  for (const word of fullName.toLowerCase().split(/[^a-z0-9]+/)) {
    // A word naming test networks in general ("testnet") names none in particular.
    const named = NETWORK_KIND_WORDS.has(word) ? null : chainOfBareName(word);
    if (named && named.chainId !== chain.chainId && named.tags?.includes('Testnet')) return named;
  }
  return null;
}

function validateRule4TestNetworkNoRelation(chain, errors) {
  const fullName = chain.theGraph?.fullName || chain.name || '';
  const named = testNetworkNamedIn(chain, fullName);
  if (!named) return;
  const hasL2Tag = chain.tags.includes('L2');
  const hasRelations = chain.relations && chain.relations.length > 0;
  if (hasL2Tag || hasRelations) return;
  errors.push({
    rule: 4,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'test_network_no_l2_or_relations',
    message: `Chain ${chain.chainId} (${chain.name}) is named after ${named.name} (${named.chainId}) but not tagged as L2 and has no relations`,
    fullName,
    namedNetwork: { chainId: named.chainId, name: named.name },
    tags: chain.tags,
    relations: chain.relations
  });
}

function validateRule5StatusConflicts(chain, errors) {
  const chainlistChain = getChainFromSource(chain.chainId, 'chainlist');
  const chainsChain = getChainFromSource(chain.chainId, 'chains');

  const statuses = [];
  if (chainlistChain?.status) statuses.push({ source: 'chainlist', status: chainlistChain.status });
  if (chainsChain?.status) statuses.push({ source: 'chains', status: chainsChain.status });

  const deprecatedInSources = statuses.filter(s => s.status === 'deprecated');
  const activeInSources = statuses.filter(s => s.status === 'active');

  if (deprecatedInSources.length > 0 && activeInSources.length > 0) {
    errors.push({
      rule: 5,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'status_conflict',
      message: `Chain ${chain.chainId} (${chain.name}) has conflicting status across sources`,
      statuses
    });
  }

  return statuses;
}

// Upstream should say a network is dead. When only chains-api does — its end-of-life seed or a
// deprecated parent — the upstream entry needs the status; the error names the file to fix.
function validateRule6DeprecatedNotUpstream(chain, statuses, errors) {
  if (chain.status !== 'deprecated') return;
  if (statuses.some(s => s.status === 'deprecated')) return;
  const inChains = Boolean(getChainFromSource(chain.chainId, 'chains'));
  errors.push({
    rule: 6,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'deprecated_not_upstream',
    message: `Chain ${chain.chainId} (${chain.name}) is deprecated here (${chain.statusReason || 'no reason recorded'}) but no upstream source marks it deprecated`,
    statusReason: chain.statusReason ?? null,
    statusInSources: statuses,
    fix: inChains
      ? { source: 'ethereum-lists/chains', file: `_data/chains/eip155-${chain.chainId}.json`, set: { status: 'deprecated' } }
      : null
  });
}

function validateRule7L2BeatMissingClassification(chain, errors) {
  if (!chain.l2Beat) return;

  // L2BEAT classifies the chain as a scaling solution. If no other source has
  // also marked it (via an l2Of/testnetOf relation from theGraph or chains),
  // then L2BEAT is alone — the upstream chain registries may be stale.
  const otherSourceConfirms = (chain.relations || []).some(r =>
    (r.kind === 'l2Of' || r.kind === 'testnetOf') &&
    (r.source === 'theGraph' || r.source === 'chains')
  );

  if (!otherSourceConfirms) {
    errors.push({
      rule: 7,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'l2beat_missing_classification',
      message: `Chain ${chain.chainId} (${chain.name}) is classified by L2BEAT (stage: ${chain.l2Beat.stage || 'n/a'}, category: ${chain.l2Beat.category || 'n/a'}) but no l2Of/testnetOf relation from theGraph or chains confirms it`,
      l2BeatStage: chain.l2Beat.stage,
      l2BeatCategory: chain.l2Beat.category,
      l2BeatSlug: chain.l2Beat.slug
    });
  }
}

function validateRule8L2BeatHostChainNoRelation(chain, errors) {
  if (!chain.l2Beat?.hostChainId) return;

  const hostId = chain.l2Beat.hostChainId;
  const matchingRelation = (chain.relations || []).find(r =>
    (r.kind === 'l2Of' || r.kind === 'testnetOf') && r.chainId === hostId
  );

  if (!matchingRelation) {
    errors.push({
      rule: 8,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'l2beat_hostchain_no_relation',
      message: `Chain ${chain.chainId} (${chain.name}) has L2BEAT hostChainId=${hostId} but no l2Of/testnetOf relation pointing to it`,
      l2BeatHostChainId: hostId,
      existingRelationTargets: (chain.relations || [])
        .filter(r => r.kind === 'l2Of' || r.kind === 'testnetOf')
        .map(r => ({ kind: r.kind, chainId: r.chainId }))
    });
  }
}

function validateRule9L2BeatCategoryNameMismatch(chain, errors) {
  if (!chain.l2Beat?.category) return;

  const fullName = (chain.l2Beat.displayName || chain.theGraph?.fullName || chain.name || '').toLowerCase();
  const category = chain.l2Beat.category.toLowerCase();

  const nameLooksZk = fullName.includes('zk') || fullName.includes('zero-knowledge');
  const nameLooksOptimistic = fullName.includes('optimistic');

  let mismatchReason = null;
  if (category.includes('zk') && nameLooksOptimistic && !nameLooksZk) {
    mismatchReason = `L2BEAT category "${chain.l2Beat.category}" but name suggests optimistic`;
  } else if (category.includes('optimistic') && nameLooksZk && !nameLooksOptimistic) {
    mismatchReason = `L2BEAT category "${chain.l2Beat.category}" but name suggests ZK`;
  }

  if (mismatchReason) {
    errors.push({
      rule: 9,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'l2beat_category_name_mismatch',
      message: `Chain ${chain.chainId} (${chain.name}): ${mismatchReason}`,
      l2BeatCategory: chain.l2Beat.category,
      fullName: chain.l2Beat.displayName || chain.theGraph?.fullName || chain.name
    });
  }
}

const L2BEAT_HIGH_TVS_THRESHOLD_USD = 1_000_000_000;

function validateRule11L2BeatStageZeroHighTvs(chain, errors) {
  if (!chain.l2Beat) return;
  if (chain.l2Beat.stage !== 'Stage 0') return;
  if (typeof chain.l2Beat.tvs !== 'number') return;
  if (chain.l2Beat.tvs < L2BEAT_HIGH_TVS_THRESHOLD_USD) return;

  errors.push({
    rule: 11,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'l2beat_stage_zero_high_tvs',
    message: `Chain ${chain.chainId} (${chain.name}) has Stage 0 classification but TVS of $${(chain.l2Beat.tvs / 1e9).toFixed(2)}B — risk signal worth surfacing`,
    l2BeatStage: chain.l2Beat.stage,
    l2BeatTvs: chain.l2Beat.tvs
  });
}

/**
 * Rule 10 is global: iterates over L2BEAT's raw project list rather than
 * per-chain, so it can flag projects whose chainId isn't in our registry.
 */
function validateRule10L2BeatUnknownChains(errors) {
  const projects = cachedData.l2beat?.projects;
  if (!Array.isArray(projects) || projects.length === 0) return;

  for (const project of projects) {
    if (project.chainId === null || project.chainId === undefined) continue;
    if (cachedData.indexed.byChainId[project.chainId]) continue;

    errors.push({
      rule: 10,
      chainId: project.chainId,
      chainName: project.displayName,
      type: 'l2beat_unknown_chain',
      message: `L2BEAT lists chainId ${project.chainId} (${project.displayName || project.slug}) but it's not in our chain registry`,
      l2BeatSlug: project.slug,
      l2BeatStage: project.stage,
      l2BeatCategory: project.category
    });
  }
}

const RPC_BLOCK_HEIGHT_DRIFT_THRESHOLD = 100;

function validateRule12RpcBlockHeightDrift(chain, errors) {
  const results = cachedData.rpcHealth?.[chain.chainId];
  if (!Array.isArray(results) || results.length < 2) return;

  const heights = results
    .filter(r => r.ok && typeof r.blockHeight === 'number')
    .map(r => ({ url: r.url, blockHeight: r.blockHeight }));

  if (heights.length < 2) return;

  let min = heights[0];
  let max = heights[0];
  for (const h of heights) {
    if (h.blockHeight < min.blockHeight) min = h;
    if (h.blockHeight > max.blockHeight) max = h;
  }

  const drift = max.blockHeight - min.blockHeight;
  if (drift > RPC_BLOCK_HEIGHT_DRIFT_THRESHOLD) {
    errors.push({
      rule: 12,
      chainId: chain.chainId,
      chainName: chain.name,
      type: 'rpc_block_height_drift',
      message: `Chain ${chain.chainId} (${chain.name}) has working RPC endpoints reporting block heights ${drift} blocks apart — likely a stuck or forked endpoint`,
      drift,
      threshold: RPC_BLOCK_HEIGHT_DRIFT_THRESHOLD,
      laggingEndpoint: min,
      leadingEndpoint: max
    });
  }
}

function normalizeChainName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bmainnet\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Heuristic check — known false positives and false negatives:
 *  - "BNB" / "BNB Smart Chain"  → suppressed (substring relationship)
 *  - "Polygon" / "Matic Network" → flagged correctly
 *  - "Optimism" / "OP Mainnet"   → suppressed (substring after normalization)
 *  - Single-letter typos in long names may slip through (substring still matches)
 * Treat results as advisory: investigate, don't fail builds on rule-13 hits.
 * Levenshtein-based variant deferred until we see real production false-rates.
 */
function validateRule13NameDisagreement(chain, errors) {
  if (!chain.theGraph?.fullName) return;
  if (!Array.isArray(chain.sources) || !chain.sources.includes('chains')) return;

  const chainsName = chain.name;
  const theGraphName = chain.theGraph.fullName;

  const a = normalizeChainName(chainsName);
  const b = normalizeChainName(theGraphName);

  if (!a || !b || a === b) return;
  if (a.includes(b) || b.includes(a)) return;

  errors.push({
    rule: 13,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'name_disagreement',
    severity: 'info', // advisory; the rule is a substring-based heuristic
    message: `Chain ${chain.chainId}: chains.json name "${chainsName}" disagrees with theGraph fullName "${theGraphName}"`,
    chainsName,
    theGraphName
  });
}

function validateRule14NativeCurrencyMismatch(chain, errors) {
  const chainsSymbol = chain.nativeCurrency?.symbol;
  const theGraphSymbol = chain.theGraph?.nativeToken;

  if (!chainsSymbol || !theGraphSymbol) return;
  if (chainsSymbol.toUpperCase() === theGraphSymbol.toUpperCase()) return;

  errors.push({
    rule: 14,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'native_currency_mismatch',
    message: `Chain ${chain.chainId} (${chain.name}): native currency symbol mismatch — chains.json="${chainsSymbol}", theGraph="${theGraphSymbol}"`,
    chainsSymbol,
    theGraphSymbol
  });
}

function validateRule15Slip44NativeSymbolMismatch(chain, errors) {
  const slip44Symbol = chain.slip44Info?.symbol;
  const nativeSymbol = chain.nativeCurrency?.symbol;

  if (!slip44Symbol || !nativeSymbol) return;
  if (slip44Symbol.toUpperCase() === nativeSymbol.toUpperCase()) return;

  errors.push({
    rule: 15,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'slip44_native_symbol_mismatch',
    message: `Chain ${chain.chainId} (${chain.name}): SLIP-44 symbol "${slip44Symbol}" disagrees with native currency symbol "${nativeSymbol}"`,
    slip44Symbol,
    nativeSymbol,
    slip44CoinType: chain.slip44Info?.coinType
  });
}

function extractRpcUrls(rpcArray) {
  if (!Array.isArray(rpcArray)) return new Set();
  return new Set(
    rpcArray
      .map(r => (typeof r === 'string' ? r : r?.url))
      .filter(url => typeof url === 'string' && url.length > 0)
  );
}

function rawSourceRpcUrls(chainId, source) {
  const entry = getChainFromSource(chainId, source === 'chains' ? 'chains' : 'chainlist');
  return extractRpcUrls(entry?.rpc);
}

function isUrlHealthy(chainId, url) {
  const results = cachedData.rpcHealth?.[chainId];
  if (!Array.isArray(results)) return false;
  return results.some(r => r.url === url && r.ok);
}

function validateRule16RpcUrlInOneSourceOnly(chain, errors) {
  if (!Array.isArray(chain.sources)) return;
  if (!chain.sources.includes('chainlist') || !chain.sources.includes('chains')) return;

  const chainlistUrls = rawSourceRpcUrls(chain.chainId, 'chainlist');
  const chainsUrls = rawSourceRpcUrls(chain.chainId, 'chains');
  if (chainlistUrls.size === 0 || chainsUrls.size === 0) return;

  const onlyInChainlistHealthy = [];
  for (const url of chainlistUrls) {
    if (!chainsUrls.has(url) && isUrlHealthy(chain.chainId, url)) {
      onlyInChainlistHealthy.push(url);
    }
  }
  const onlyInChainsHealthy = [];
  for (const url of chainsUrls) {
    if (!chainlistUrls.has(url) && isUrlHealthy(chain.chainId, url)) {
      onlyInChainsHealthy.push(url);
    }
  }

  if (onlyInChainlistHealthy.length === 0 && onlyInChainsHealthy.length === 0) return;

  errors.push({
    rule: 16,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'rpc_url_in_one_source_only',
    message: `Chain ${chain.chainId} (${chain.name}) has healthy RPC URLs present in one source only — the other source may need updating`,
    onlyInChainlistHealthy,
    onlyInChainsHealthy
  });
}

// The indexer's propagateDeprecatedStatus pass guarantees a chain built on
// (l2Of) or testing (testnetOf) a deprecated chain is itself deprecated.
// This rule re-checks that invariant on the final index — any hit means the
// propagation pass regressed or was bypassed.
function validateRule17ActiveChildOfDeprecatedParent(chain, errors, byChainId) {
  if (chain.status === 'deprecated') return;
  for (const relation of chain.relations || []) {
    if ((relation.kind !== 'l2Of' && relation.kind !== 'testnetOf') || relation.chainId === undefined) continue;
    const parent = byChainId[relation.chainId];
    if (parent?.status === 'deprecated') {
      errors.push({
        rule: 17,
        chainId: chain.chainId,
        chainName: chain.name,
        type: 'active_child_of_deprecated_parent',
        message: `Chain ${chain.chainId} (${chain.name}) is ${chain.status || 'active'} but its ${relation.kind} parent ${relation.chainId} (${parent.name}) is deprecated`,
        parentChainId: relation.chainId,
        relationKind: relation.kind
      });
    }
  }
}


// Every listed RPC endpoint is gone — its name no longer resolves, nothing listens, or it never
// answers — and no source calls the network dead. Either the network is dead and upstream should
// mark it, or it moved and upstream lists stale endpoints. An endpoint that answered at all (a
// rate limit, an error, a method it refuses) is not counted as gone.
function validateRule18NoReachableRpc(chain, errors, now = Date.now()) {
  if (chain.status === 'deprecated') return;
  const results = cachedData.rpcHealth?.[chain.chainId];
  if (!Array.isArray(results) || results.length === 0) return;
  // Every endpoint silent for days (chainRefresher.js keeps the clock): an outage or one bad
  // sweep from our side is not a dead network. A reset connection or an unrecognised error may be
  // our own side, so neither starts the clock.
  const since = (r) => Date.parse(r.unansweredSince ?? '');
  if (!results.every(r => !r.ok && NO_ANSWER_FAILURES.has(r.failure) && now - since(r) >= RPC_DEAD_AFTER_MS)) return;
  const unansweredSince = new Date(Math.max(...results.map(since))).toISOString();
  errors.push({
    rule: 18,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'no_reachable_rpc',
    message: `Chain ${chain.chainId} (${chain.name}) is ${chain.status || 'active'} but none of its ${results.length} RPC endpoints has answered since ${unansweredSince.slice(0, 10)} — dead and unmarked upstream, or its endpoints moved`,
    status: chain.status ?? null,
    unansweredSince,
    endpoints: results.map(r => ({ url: r.url, failure: r.failure, error: r.error, unansweredSince: r.unansweredSince }))
  });
}

// Deprecated, yet an endpoint still serves blocks: the network may live on, or the endpoint is a
// leftover. Either way the status deserves a second look.
function validateRule19DeprecatedRpcAnswers(chain, errors) {
  if (chain.status !== 'deprecated') return;
  const working = (cachedData.rpcHealth?.[chain.chainId] ?? []).filter(r => r.ok);
  if (working.length === 0) return;
  errors.push({
    rule: 19,
    chainId: chain.chainId,
    chainName: chain.name,
    type: 'deprecated_rpc_answers',
    message: `Chain ${chain.chainId} (${chain.name}) is deprecated but ${working.length} RPC endpoint(s) still serve blocks`,
    statusReason: chain.statusReason ?? null,
    endpoints: working.map(r => ({ url: r.url, blockHeight: r.blockHeight }))
  });
}

// One chain ID, different networks: the record was built from the sources that agree and the
// rest left out (src/domain/sourceIdentity.js). Listed with every source's name and symbol so a
// person can tell which registry reused or mistyped the ID.
function validateRule20ChainIdCollisions(errors) {
  for (const c of cachedData.indexed?.identityConflicts ?? []) {
    const chain = cachedData.indexed.byChainId?.[c.chainId];
    const said = (s) => `${s} "${c.identities[s].name}" (${c.identities[s].symbol ?? 'no symbol'})`;
    errors.push({
      rule: 20,
      chainId: c.chainId,
      chainName: chain?.name ?? c.identities[c.kept[0]]?.name ?? null,
      type: 'chain_id_collision',
      message: `Chain ${c.chainId} is ${c.kept.map(said).join(' / ')} but ${c.excluded.map(said).join(' / ')} — record built from ${c.kept.join(' + ')}; ${c.excluded.join(' + ')} left out`,
      kept: c.kept,
      excluded: c.excluded,
      identities: c.identities
    });
  }
}

function validateChain(chain, errors) {
  validateRule1RelationConflicts(chain, errors);
  validateRule2NetworkTypeClaims(chain, errors);
  validateRule3NameTestnetMismatch(chain, errors);
  validateRule4TestNetworkNoRelation(chain, errors);
  const statuses = validateRule5StatusConflicts(chain, errors);
  validateRule6DeprecatedNotUpstream(chain, statuses, errors);
  validateRule7L2BeatMissingClassification(chain, errors);
  validateRule8L2BeatHostChainNoRelation(chain, errors);
  validateRule9L2BeatCategoryNameMismatch(chain, errors);
  validateRule11L2BeatStageZeroHighTvs(chain, errors);
  validateRule12RpcBlockHeightDrift(chain, errors);
  validateRule13NameDisagreement(chain, errors);
  validateRule14NativeCurrencyMismatch(chain, errors);
  validateRule15Slip44NativeSymbolMismatch(chain, errors);
  validateRule16RpcUrlInOneSourceOnly(chain, errors);
  validateRule17ActiveChildOfDeprecatedParent(chain, errors, cachedData.indexed.byChainId);
  validateRule18NoReachableRpc(chain, errors);
  validateRule19DeprecatedRpcAnswers(chain, errors);
}

export function validateChainData() {
  if (!cachedData.indexed || !cachedData.theGraph || !cachedData.chainlist || !cachedData.chains) {
    return {
      error: 'Data not loaded. Please reload data sources first.',
      errors: []
    };
  }

  const errors = [];
  // Which names are test networks comes from the registry itself.
  // The same array the other services learn from, so the memo holds between them.
  learnNetworkWords(cachedData.indexed.all ? getAllChains() : Object.values(cachedData.indexed.byChainId));

  Object.values(cachedData.indexed.byChainId).forEach(chain => {
    validateChain(chain, errors);
  });

  // Rule 10 is global (iterates L2BEAT projects, not chains).
  validateRule10L2BeatUnknownChains(errors);
  validateRule20ChainIdCollisions(errors);

  const errorsByRule = {
    rule1_relation_conflicts: errors.filter(e => e.rule === 1),
    rule2_network_type_claims_conflict: errors.filter(e => e.rule === 2),
    rule3_name_testnet_mismatch: errors.filter(e => e.rule === 3),
    rule4_test_network_no_relation: errors.filter(e => e.rule === 4),
    rule5_status_conflicts: errors.filter(e => e.rule === 5),
    rule6_deprecated_not_upstream: errors.filter(e => e.rule === 6),
    rule7_l2beat_missing_classification: errors.filter(e => e.rule === 7),
    rule8_l2beat_hostchain_no_relation: errors.filter(e => e.rule === 8),
    rule9_l2beat_category_name_mismatch: errors.filter(e => e.rule === 9),
    rule10_l2beat_unknown_chains: errors.filter(e => e.rule === 10),
    rule11_l2beat_stage_zero_high_tvs: errors.filter(e => e.rule === 11),
    rule12_rpc_block_height_drift: errors.filter(e => e.rule === 12),
    rule13_name_disagreement: errors.filter(e => e.rule === 13),
    rule14_native_currency_mismatch: errors.filter(e => e.rule === 14),
    rule15_slip44_native_symbol_mismatch: errors.filter(e => e.rule === 15),
    rule16_rpc_url_in_one_source_only: errors.filter(e => e.rule === 16),
    rule17_active_child_of_deprecated_parent: errors.filter(e => e.rule === 17),
    rule18_no_reachable_rpc: errors.filter(e => e.rule === 18),
    rule19_deprecated_rpc_answers: errors.filter(e => e.rule === 19),
    rule20_chain_id_collision: errors.filter(e => e.rule === 20)
  };

  return {
    totalErrors: errors.length,
    errorsByRule,
    summary: {
      rule1: errorsByRule.rule1_relation_conflicts.length,
      rule2: errorsByRule.rule2_network_type_claims_conflict.length,
      rule3: errorsByRule.rule3_name_testnet_mismatch.length,
      rule4: errorsByRule.rule4_test_network_no_relation.length,
      rule5: errorsByRule.rule5_status_conflicts.length,
      rule6: errorsByRule.rule6_deprecated_not_upstream.length,
      rule7: errorsByRule.rule7_l2beat_missing_classification.length,
      rule8: errorsByRule.rule8_l2beat_hostchain_no_relation.length,
      rule9: errorsByRule.rule9_l2beat_category_name_mismatch.length,
      rule10: errorsByRule.rule10_l2beat_unknown_chains.length,
      rule11: errorsByRule.rule11_l2beat_stage_zero_high_tvs.length,
      rule12: errorsByRule.rule12_rpc_block_height_drift.length,
      rule13: errorsByRule.rule13_name_disagreement.length,
      rule14: errorsByRule.rule14_native_currency_mismatch.length,
      rule15: errorsByRule.rule15_slip44_native_symbol_mismatch.length,
      rule16: errorsByRule.rule16_rpc_url_in_one_source_only.length,
      rule17: errorsByRule.rule17_active_child_of_deprecated_parent.length,
      rule18: errorsByRule.rule18_no_reachable_rpc.length,
      rule19: errorsByRule.rule19_deprecated_rpc_answers.length,
      rule20: errorsByRule.rule20_chain_id_collision.length
    },
    allErrors: errors
  };
}
