import { getChainUpgrades } from '../../services/upgrades.js';
import { sendError } from '../util/sendError.js';

/**
 * The cross-feed upgrade timeline: scheduled upgrades/maintenance with required software,
 * urgency, incidents that followed on the same network, and forum/news context. One call
 * answers "when is the next upgrade, what version is required, and what happened last time".
 */
export async function upgradesRoutes(fastify) {
  fastify.get('/upgrades', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chainId: { type: 'integer', description: 'Only upgrades touching this chain ID' },
          network: { type: 'string', maxLength: 80, description: 'Network name or slug (e.g. "Solana Mainnet", "gnosis") — covers networks with no EVM chain ID' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return await getChainUpgrades(request.query);
    } catch (error) {
      // The upstream feed being down is the only throw path; 503 says "try later",
      // which is the truth.
      return sendError(reply, 503, `Upgrade timeline unavailable: ${error.message}`);
    }
  });
}
