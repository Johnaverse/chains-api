import { getRepositoryInputs } from '../../sources/networkResearch.js';
import { getChainById } from '../../store/queries.js';

/**
 * Raw node/client repository research per chain, for chains-client-feed's registry. Static
 * data that only changes on deploy, so it is built once — after the registry has loaded, so
 * chain names resolve — and served from memory.
 */
let cached = null;

export async function repositoriesRoutes(fastify) {
  fastify.get('/repositories', async () => {
    if (cached) return cached;
    const inputs = getRepositoryInputs(chainId => getChainById(chainId)?.name ?? null);
    // Before the registry loads only the hardware names exist; don't pin that.
    if (inputs.networks.every(n => n.name)) cached = inputs;
    return inputs;
  });
}

/** Test-only: drop the memoised response after swapping datasets. */
export function _resetRepositoriesForTests() {
  cached = null;
}
