import {
  getClientReleases,
  getFeedClients,
  getFeedClient,
  getNetworkClients,
  clientFeedConfigured,
  ClientFeedNotConfiguredError,
  ClientFeedNotFoundError,
  ClientFeedBadRequestError,
  MAX_RELEASE_LIMIT
} from '../../sources/clientFeed.js';
import { getLatestRelease, parseRepo } from '../../services/latestRelease.js';
import { sendError } from '../util/sendError.js';

/**
 * Proxy for chains-client-feed (client releases, extracted hard forks, client → networks index).
 * The feed has no public host, so this is how the dashboard reads it. Unconfigured → 503 (the
 * dashboard hides its Releases view and drawer section on that); upstream down with nothing
 * cached → 502.
 *
 * Every path param is pattern-checked before it is URI-encoded into the upstream path, and a
 * name made only of dots is refused: `..` survives encodeURIComponent and WHATWG URL parsing
 * would resolve it, walking out of /clients on the feed.
 */
const NAME = '^(?!\\.+$)[A-Za-z0-9_.-]{1,100}$';

const chainIdSchema = { type: 'integer', minimum: 0, description: 'Chain ID' };

async function proxy(reply, fn) {
  if (!clientFeedConfigured()) return sendError(reply, 503, 'Client release feed not configured');
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ClientFeedNotConfiguredError) return sendError(reply, 503, 'Client release feed not configured');
    if (error instanceof ClientFeedNotFoundError) return sendError(reply, 404, error.message);
    if (error instanceof ClientFeedBadRequestError) return sendError(reply, 400, error.message);
    return sendError(reply, 502, error.message);
  }
}

// A route that takes no filter still rejects one: `?chainId=1` must be a 400, not an unfiltered 200.
const NO_QUERY = { type: 'object', additionalProperties: false, properties: {} };

export async function clientReleasesRoutes(fastify) {
  fastify.get('/client-releases', {
    schema: {
      description: 'Blockchain client releases and changelog entries from chains-client-feed, newest first, with any hard fork the notes announce (`enrichment.fork`). 503 when the feed is not configured.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_RELEASE_LIMIT, default: 100 },
          fork: { type: 'boolean', description: 'true = only releases announcing a fork; false = only those that do not' },
          chainId: chainIdSchema,
          repo: {
            type: 'string',
            pattern: '^((github|gitlab):)?(?!\\.+/)[A-Za-z0-9_.-]{1,100}/(?!\\.+$)[A-Za-z0-9_.-]{1,100}$',
            description: 'Only this repository (`owner/repo` = GitHub, or `github:` / `gitlab:` prefixed)',
            errorMessage: { pattern: 'repo must be owner/repo' }
          },
          since: {
            type: 'string',
            maxLength: 40,
            pattern: '^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.]+(Z|[+-]\\d{2}:?\\d{2})?)?$',
            description: 'Only releases published at or after this ISO date/time',
            errorMessage: { pattern: 'since must be an ISO date or date-time' }
          },
          until: {
            type: 'string',
            maxLength: 40,
            pattern: '^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.]+(Z|[+-]\\d{2}:?\\d{2})?)?$',
            description: 'Only releases published at or before this ISO date/time (inclusive; a bare date covers that whole UTC day)',
            errorMessage: { pattern: 'until must be an ISO date or date-time' }
          }
        }
      }
    }
  }, (request, reply) => proxy(reply, () => getClientReleases(request.query)));

  fastify.get('/client-releases/latest', {
    schema: {
      description: 'The latest release of one client repository: version, release link, whether it ships a hard fork, '
        + 'whether the upgrade is mandatory, whether it is a security release (a GitHub advisory naming this version as '
        + 'patched, or the notes) and which CLI flags / config keys it changes, each with the line of the notes that says '
        + 'so. `null` means unknown (not classified yet, no notes), never "no". Stable releases only unless '
        + '`prerelease=true`; a monorepo lists the newest release of each component in `components`.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['repo'],
        properties: {
          repo: {
            type: 'string',
            minLength: 3,
            maxLength: 300,
            description: '`owner/repo` (GitHub), `github:owner/repo`, `gitlab:owner/repo`, or the repository URL',
            errorMessage: { minLength: 'repo must be owner/repo' }
          },
          component: {
            type: 'string',
            pattern: '^[A-Za-z0-9_.@/-]{1,100}$',
            description: 'For a monorepo, the component whose latest release to return (e.g. `op-node`)',
            errorMessage: { pattern: 'Invalid component' }
          },
          prerelease: { type: 'boolean', default: false, description: 'true = the newest release even if it is a prerelease' }
        }
      }
    }
  }, (request, reply) => {
    const { repo, component, prerelease } = request.query;
    if (!parseRepo(repo)) return sendError(reply, 400, 'repo must be owner/repo, github:owner/repo, gitlab:owner/repo or a GitHub/GitLab repository URL');
    return proxy(reply, () => getLatestRelease({ repo, component, includePrerelease: prerelease }));
  });

  fastify.get('/client-releases/clients', {
    schema: {
      description: 'Client registry from chains-client-feed: repositories and name-only clients, filtered by text, kind or chain.',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          q: { type: 'string', maxLength: 100, description: 'Substring of the repo slug or any client name' },
          kind: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$', description: 'Repository kind (e.g. execution, consensus, node)' },
          chainId: chainIdSchema,
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
        }
      }
    }
  }, (request, reply) => proxy(reply, () => getFeedClients(request.query)));

  fastify.get('/client-releases/clients/:host/:owner/:repo', {
    schema: {
      description: 'One client repository with every network it serves (reverse lookup), its latest release and latest fork.',
      querystring: NO_QUERY,
      params: {
        type: 'object',
        required: ['host', 'owner', 'repo'],
        properties: {
          host: { type: 'string', enum: ['github', 'gitlab'] },
          owner: { type: 'string', pattern: NAME, errorMessage: { pattern: 'Invalid owner' } },
          repo: { type: 'string', pattern: NAME, errorMessage: { pattern: 'Invalid repo' } }
        }
      }
    }
  }, (request, reply) => {
    const { host, owner, repo } = request.params;
    return proxy(reply, () => getFeedClient(host, owner, repo));
  });

  fastify.get('/client-releases/networks/:chainId', {
    schema: {
      description: 'Clients known to serve a chain, each with the kinds it plays there, its latest release and latest fork.',
      querystring: NO_QUERY,
      params: {
        type: 'object',
        required: ['chainId'],
        properties: { chainId: chainIdSchema }
      }
    }
  }, (request, reply) => proxy(reply, () => getNetworkClients(request.params.chainId)));
}
