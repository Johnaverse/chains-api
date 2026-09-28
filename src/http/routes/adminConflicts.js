import { getAuth } from '../../services/auth/index.js';
import { readSession, originAllowed } from '../../services/auth/session.js';
import { getConflicts, ConflictError } from '../../services/conflicts/index.js';
import { sendError } from '../util/sendError.js';

/**
 * The admin API behind public/admin.html: review the cross-source conflicts that /validate
 * finds, and record a decision about each.
 *
 * Every route needs a signed-in session, and every write passes the same Origin check as the
 * sign-in routes. Who counts as an admin is the sign-in allowlist itself: AUTH_ALLOWED_EMAILS
 * is short by design (it gates who can receive a sign-in email at all), so everyone on it may
 * triage. Like /auth, nothing here is registered unless accounts are configured.
 */

const conflictIdParam = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^[0-9a-f]{20}$' } },
  required: ['id']
};

export async function adminConflictRoutes(fastify, opts = {}) {
  const auth = opts.auth ?? getAuth();
  if (!auth.enabled) return;
  const conflicts = () => opts.conflicts ?? getConflicts();

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET' && !originAllowed(request, auth)) {
      return sendError(reply, 403, 'Cross-origin request refused');
    }
    const session = await readSession(request, auth);
    if (!session) return sendError(reply, 401, 'Sign in to manage conflicts.');
    request.admin = session.user;
  });

  // One place maps service errors to HTTP, so a 404 for a vanished conflict and a 503 for
  // "data not loaded yet" read the same from every route.
  function fail(reply, err) {
    if (err instanceof ConflictError) return sendError(reply, err.status, err.message);
    throw err;
  }

  fastify.get('/admin/conflicts', {
    schema: {
      description: 'The conflict review queue: counts per state, a per-rule breakdown, one page of conflicts with their evidence, and decisions whose conflict no longer occurs. Needs a signed-in session.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', enum: ['open', 'acknowledged', 'dismissed', 'all'], default: 'open' },
          rule: { type: 'integer', minimum: 1, maximum: 99 },
          q: { type: 'string', maxLength: 100 },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          offset: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      return await conflicts().list(request.query);
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post('/admin/conflicts/:id/review', {
    schema: {
      description: 'Acknowledge (real, being tracked), dismiss (false positive — a note is required), or reopen a conflict that occurs now. Recorded with the admin\'s email in the audit history.',
      params: conflictIdParam,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { type: 'string', enum: ['open', 'acknowledged', 'dismissed'] },
          note: { type: 'string', maxLength: 1000 }
        },
        required: ['state']
      }
    }
  }, async (request, reply) => {
    try {
      return await conflicts().review(request.params.id, request.body, request.admin.email);
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.post('/admin/conflicts/prune-resolved', {
    schema: { description: 'Clear every decision whose conflict no longer occurs (fixed upstream, or its value changed). Recorded in the history.' }
  }, async (request, reply) => {
    try {
      return { pruned: await conflicts().pruneResolved(request.admin.email) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  fastify.get('/admin/conflicts/history', {
    schema: {
      description: 'Every decision, reopen and prune, newest first: who, when, which conflict, and why.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }
      }
    }
  }, async (request) => ({ history: await conflicts().history(request.query.limit) }));
}
