import { FEEDBACK_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../../../config.js';
import { addFeedback } from '../../services/feedback.js';

/**
 * The wrong-info feedback loop. The dashboard correlates three live feeds by
 * heuristics (network join, time windows) — inevitably some links are wrong,
 * and no automation can know which. POST lets a reader flag one ("not
 * related", "wrong version"). Write-only: reports are never served back over
 * the public API. They are kept in feedback.jsonl next to the data cache for a
 * separate backend to review; this service has no login.
 */

const FEEDBACK_KINDS = ['upgrade', 'incident', 'provider', 'forum', 'news', 'chain', 'other'];
const FEEDBACK_REASONS = ['wrong_chain', 'wrong_version', 'wrong_time', 'not_related', 'misclassified', 'outdated', 'other'];

const feedbackBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      enum: FEEDBACK_KINDS,
      description: 'What the report is about',
      errorMessage: { enum: `Field "kind" must be one of: ${FEEDBACK_KINDS.join(', ')}` }
    },
    refId: {
      type: 'string',
      maxLength: 200,
      description: 'Identifier of the item being reported (incident id, upgrade/incident title, chain id…)',
      errorMessage: { maxLength: 'Field "refId" too long. Max length: 200' }
    },
    reason: {
      type: 'string',
      enum: FEEDBACK_REASONS,
      description: 'Why the item is wrong',
      errorMessage: { enum: `Field "reason" must be one of: ${FEEDBACK_REASONS.join(', ')}` }
    },
    comment: {
      type: 'string',
      maxLength: 500,
      description: 'Optional free-text detail',
      errorMessage: { maxLength: 'Field "comment" too long. Max length: 500' }
    },
    page: {
      type: 'string',
      maxLength: 100,
      description: 'Dashboard view the report came from',
      errorMessage: { maxLength: 'Field "page" too long. Max length: 100' }
    }
  },
  required: ['kind', 'reason'],
  errorMessage: {
    required: {
      kind: 'Field "kind" is required',
      reason: 'Field "reason" is required'
    }
  }
};

export async function feedbackRoutes(fastify) {
  fastify.post('/feedback', {
    config: {
      // Same tight per-route budget as /reload: feedback is a rare human
      // action, so anything chattier than a handful per window is abuse.
      rateLimit: {
        max: FEEDBACK_RATE_LIMIT_MAX,
        timeWindow: RATE_LIMIT_WINDOW_MS
      }
    },
    schema: {
      description: 'Report wrong or misattributed information (an upgrade linked to the wrong incident, a stale version, a mis-mapped chain). Stored in memory (last 1000) with a best-effort file mirror; no IP or user-agent is recorded.',
      body: feedbackBodySchema,
      response: {
        201: {
          type: 'object',
          properties: {
            received: { type: 'boolean' },
            id: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const record = await addFeedback(request.body);
    return reply.code(201).send({ received: true, id: record.id });
  });
}
