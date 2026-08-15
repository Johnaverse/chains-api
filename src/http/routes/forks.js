import { getForks } from '../../services/forks.js';
import { FORK_PHASE } from '../../domain/forks.js';
import { sendError } from '../util/sendError.js';

/**
 * Forks as entities rather than as events.
 *
 * `/upgrades` answers "what maintenance is scheduled" — one entry per provider window.
 * This answers "what forks are coming" — one entry per fork per network, with every provider's
 * window attached to it. The distinction matters because a single fork produces one event per
 * provider plus the network's own announcement, and reading those as separate upgrades is what
 * made a fork calendar impossible to build.
 */
export async function forksRoutes(fastify) {
  fastify.get('/forks', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chainId: { type: 'integer', description: 'Only forks touching this chain ID' },
          phase: {
            type: 'string',
            enum: Object.values(FORK_PHASE),
            description: 'upcoming (activation ahead), past (behind), cancelled (a source said so), unscheduled (marked as a fork, no date known)'
          },
          scheduledOnly: {
            type: 'boolean',
            default: false,
            description: 'Drop forks with no known activation time. What a calendar wants — distinct from phase, because a fork can be real and announced with no day named yet.'
          },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return await getForks(request.query);
    } catch (error) {
      // The upstream status feed being unreachable is the only throw path.
      return sendError(reply, 503, `Fork timeline unavailable: ${error.message}`);
    }
  });
}
