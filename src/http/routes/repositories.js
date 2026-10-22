import { getRepositoryInputs } from '../../sources/networkResearch.js';
import { getChainById, getAllChains } from '../../store/queries.js';
import { learnNetworkWords, testNetworkWords } from '../../domain/networkWords.js';
import { cachedData } from '../../store/cache.js';

/**
 * Raw node/client repository research per chain, for chains-client-feed's registry. Built once
 * per registry version — after the registry has loaded, so chain names resolve — and served
 * from memory until the registry reloads.
 */
let cached = null;
// The registry version the response was built from: a reload (sourceRefresher.js) rebuilds it, so
// the feed gets the words, aliases and testnet flags learned from the new registry.
let cachedVersion = null;

// `evm-56`-style ids carry no name, so they can never identify a network in release text.
const NAMELESS = /^evm-\d+$/i;

export function aliasesOf(chain) {
  if (!chain) return [];
  const names = [chain['theGraph-id'], ...(Array.isArray(chain.aliases) ? chain.aliases : [])]
    .filter(name => typeof name === 'string' && name.trim() && !NAMELESS.test(name.trim()))
    .map(name => name.trim().toLowerCase());
  return [...new Set(names)];
}

export async function repositoriesRoutes(fastify) {
  fastify.get('/repositories', {
    schema: {
      description: 'Raw node/client repository research per chain, for chains-client-feed\'s registry. Takes no query parameters.',
      querystring: { type: 'object', additionalProperties: false, properties: {} }
    }
  }, async () => {
    if (cached && cachedVersion === cachedData.lastUpdated) return cached;
    const inputs = getRepositoryInputs(chainId => getChainById(chainId)?.name ?? null);
    // Other names the registry knows a network by (The Graph's id, its aliases): the feed matches
    // a release's fork network ("BSC Chapel testnet") against them, not only the display name.
    for (const network of inputs.networks) {
      const chain = getChainById(network.chainId);
      network.aliases = aliasesOf(chain);
      // The registry's own word on test networks, so the feed keeps no list of its own.
      if (chain) network.testnet = Array.isArray(chain.tags) && chain.tags.includes('Testnet');
    }
    // Words that name test networks, learned from the registry (networkWords.js): the feed reads
    // "Hoodi" and "BSC Chapel" in release notes as test networks with them.
    learnNetworkWords(getAllChains());
    inputs.testNetworkWords = testNetworkWords();
    // Before the registry loads, names come from the hardware research alone and every alias
    // list is empty; pinning that would cost the feed its alias matches until a restart.
    if (inputs.networks.some(n => getChainById(n.chainId))) {
      cached = inputs;
      cachedVersion = cachedData.lastUpdated;
    }
    return inputs;
  });
}

/** Test-only: drop the memoised response after swapping datasets. */
export function _resetRepositoriesForTests() {
  cached = null;
}
