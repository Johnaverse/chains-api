import { getProviderStats } from '../../services/providerStats.js';
import { sendError } from '../util/sendError.js';

/**
 * RPC-provider quality indicators. `availability` is THE availability metric
 * (time-weighted from status-page incident durations, honestly labelled
 * self-reported — a silent page looks perfect); `endpointReachability` is a
 * registry data-quality signal (do registry-listed URLs answer our probes?),
 * never to be read as provider uptime.
 */
export async function providersRoutes(fastify) {
  fastify.get('/providers/stats', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: {
            type: 'string',
            maxLength: 40,
            description: 'Only this provider id (e.g. "infura", "quicknode")'
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return await getProviderStats(request.query);
    } catch (error) {
      // The upstream incident feed being down is the only throw path; 503
      // says "try later", which is the truth.
      return sendError(reply, 503, `Provider stats unavailable: ${error.message}`);
    }
  });
}
