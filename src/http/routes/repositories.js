import { getRepositoryInputs } from '../../sources/networkResearch.js';
import { getChainById } from '../../store/queries.js';

/**
 * Raw node/client repository research per chain, for chains-client-feed's registry. Static
 * data that only changes on deploy, so it is built once — after the registry has loaded, so
 * chain names resolve — and served from memory.
 */
let cached = null;

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
    if (cached) return cached;
    const inputs = getRepositoryInputs(chainId => getChainById(chainId)?.name ?? null);
    // Other names the registry knows a network by (The Graph's id, its aliases): the feed matches
    // a release's fork network ("BSC Chapel testnet") against them, not only the display name.
    for (const network of inputs.networks) network.aliases = aliasesOf(getChainById(network.chainId));
    // Before the registry loads only the hardware names exist; don't pin that.
    if (inputs.networks.every(n => n.name)) cached = inputs;
    return inputs;
  });
}

/** Test-only: drop the memoised response after swapping datasets. */
export function _resetRepositoriesForTests() {
  cached = null;
}
