import { createHash } from 'node:crypto';
import { cachedData } from '../../store/cache.js';
import { aliasTerms } from '../../store/queries.js';

/**
 * GET /summary — slim, dashboard-oriented projection of the in-memory store.
 *
 * The GitHub Pages dashboard used to download the full /export snapshot
 * (~6 MB raw) on every visit, though it renders only names, tags, relations,
 * an RPC count, and L2BEAT headline numbers. This endpoint serves exactly
 * that projection straight from memory (no disk read), pre-serialized once
 * per data version, with an ETag so unchanged data revalidates as a 304.
 */

// Count endpoints a browser could actually call: http(s), not key-templated.
function usableRpcCount(rpc) {
  if (!Array.isArray(rpc)) return 0;
  let n = 0;
  for (const entry of rpc) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (typeof url === 'string' && url.startsWith('http') && !url.includes('${')) n++;
  }
  return n;
}

function slimChain(chain) {
  const slim = {
    chainId: chain.chainId,
    name: chain.name ?? null,
    rpcCount: usableRpcCount(chain.rpc)
  };
  if (chain.shortName) slim.shortName = chain.shortName;
  // Only non-default statuses ship (deprecated/incubating) — the dashboard
  // badges them and demotes dead chains in its search; 'active' is implied.
  if (chain.status && chain.status !== 'active') slim.status = chain.status;
  // Community names of renamed chains (from the TheGraph registry) so the
  // dashboard's client-side search finds "optimism" → OP Mainnet just like
  // the server's /search does. Machine ids ("evm-10") and terms already
  // covered by name/shortName are dropped to keep the payload slim.
  const nameLower = (chain.name ?? '').toLowerCase();
  const shortLower = (chain.shortName ?? '').toLowerCase();
  const aliases = [...aliasTerms(chain)].filter(
    t => !t.startsWith('evm-') && !t.startsWith('evm ') && t !== nameLower && t !== shortLower
  );
  if (aliases.length) slim.aliases = aliases;
  if (Array.isArray(chain.tags) && chain.tags.length) slim.tags = chain.tags;
  // Technology family from the research dataset; the drawer shows it without a detail fetch.
  if (chain.family) slim.family = chain.family;
  if (Array.isArray(chain.relations) && chain.relations.length) {
    slim.relations = chain.relations
      .filter(r => r.chainId != null)
      .map(r => ({ kind: r.kind, chainId: r.chainId }));
  }
  return slim;
}

function slimProject(p) {
  return {
    slug: p.slug ?? null,
    displayName: p.displayName ?? null,
    chainId: p.chainId ?? null,
    category: p.category ?? null,
    stage: p.stage ?? null,
    stack: p.stack ?? null,
    daLayer: p.daLayer ?? null,
    hostChainId: p.hostChainId ?? null,
    tvs: typeof p.tvs === 'number' ? p.tvs : null
  };
}

// Built (and stringified) once per data version; L2BEAT hot-merges bump
// fetchedAt without touching lastUpdated, so key on both.
let summaryCache = { lastUpdated: null, l2beatFetchedAt: null, body: null, etag: null };

function buildSummary() {
  const current = {
    lastUpdated: cachedData.lastUpdated,
    l2beatFetchedAt: cachedData.l2beat?.fetchedAt ?? null
  };
  if (
    summaryCache.body !== null &&
    summaryCache.lastUpdated === current.lastUpdated &&
    summaryCache.l2beatFetchedAt === current.l2beatFetchedAt
  ) {
    return summaryCache;
  }

  const chains = (cachedData.indexed?.all ?? []).map(slimChain);
  const l2beat = cachedData.l2beat
    ? {
        source: cachedData.l2beat.source ?? null,
        fetchedAt: cachedData.l2beat.fetchedAt ?? null,
        projects: (cachedData.l2beat.projects ?? []).map(slimProject)
      }
    : null;

  const body = JSON.stringify({
    lastUpdated: cachedData.lastUpdated,
    count: chains.length,
    chains,
    l2beat
  });
  const etag = `"${createHash('sha1').update(body).digest('hex')}"`;

  summaryCache = { ...current, body, etag };
  return summaryCache;
}

// Test-only helper.
export function _resetSummaryCacheForTests() {
  summaryCache = { lastUpdated: null, l2beatFetchedAt: null, body: null, etag: null };
}

export async function summaryRoute(fastify) {
  fastify.get('/summary', {
    schema: {
      description: 'Slim projection of all chains (id, name, tags, relations, RPC count) '
        + 'plus L2BEAT headline data. Designed for dashboards; a fraction of the size of /export. '
        + 'Supports ETag revalidation (If-None-Match → 304).'
    }
  }, async (request, reply) => {
    const { body, etag } = buildSummary();
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    return reply.type('application/json; charset=utf-8').send(body);
  });
}
