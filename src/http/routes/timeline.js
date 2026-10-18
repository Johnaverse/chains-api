import { getTimeline, TIMELINE_TYPES } from '../../services/timeline.js';
import { FORK_PHASE } from '../../domain/forks.js';
import { sendError } from '../util/sendError.js';

/**
 * The event timeline: hardforks, software updates and maintenance, each with what the feeds
 * say about it grouped under it — the client releases that ship it, every provider's rollout
 * window, the news and forum posts about it, and incidents that followed it.
 *
 * `/forks` lists forks and `/upgrades` lists provider windows; this is the two joined, plus
 * releases and news. With `chainId` and `type=hardfork` it is that chain's hardfork history.
 */
export async function timelineRoutes(fastify) {
  fastify.get('/timeline', {
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chainId: { type: 'integer', description: 'Only events touching this chain ID — with type=hardfork, its hardfork history' },
          type: {
            type: 'string',
            maxLength: 60,
            pattern: `^(${Object.values(TIMELINE_TYPES).join('|')})(,(${Object.values(TIMELINE_TYPES).join('|')}))*$`,
            description: 'Comma list of hardfork (a consensus fork / network upgrade), software_update (a client version rolled out with no fork, never an incident), maintenance (a provider window naming no software)'
          },
          phase: {
            type: 'string',
            enum: Object.values(FORK_PHASE),
            description: 'upcoming, past, cancelled, or unscheduled (no date known)'
          },
          since: { type: 'string', maxLength: 40, description: 'Only events activating at/after this time (drops undated events)' },
          until: { type: 'string', maxLength: 40, description: 'Only events activating at/before this time; a bare date (YYYY-MM-DD) includes that whole UTC day (drops undated events)' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return await getTimeline(request.query);
    } catch (error) {
      // Thrown only when neither the fork feeds nor the status feed answered.
      return sendError(reply, 503, `Timeline unavailable: ${error.message}`);
    }
  });
}
