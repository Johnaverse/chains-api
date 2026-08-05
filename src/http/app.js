import { dirname, join } from 'node:path';
import { fileURLToPath as toFilePath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import ajvErrors from 'ajv-errors';
import pkg from '../../package.json' with { type: 'json' };
import { initializeDataOnStartup } from '../services/loader.js';
import { startRpcHealthCheck } from '../services/rpcHealth.js';
import { startL2BeatRefresh } from '../services/l2beatRefresher.js';
import { startSourceRefresher } from '../services/sourceRefresher.js';
import {
  BODY_LIMIT,
  MAX_PARAM_LENGTH,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  CORS_ORIGIN
} from '../../config.js';

// Browser feed origins the /ui dashboard fetches from — kept in lock-step
// with STATUS_NEWS_BASE / FORUM_NEWS_BASE / NEWS_BASE in public/app.js.
// http + ws each.
const DASHBOARD_FEED_ORIGINS = [
  'https://chains-status-news.johnaverse.cc', 'wss://chains-status-news.johnaverse.cc',
  'https://chains-forum-news.johnaverse.cc', 'wss://chains-forum-news.johnaverse.cc',
  // chains-news (ecosystem news relay). Listed ahead of its public rollout so
  // the dashboard's News tab works the moment DNS resolves; until then the
  // fetch simply fails and the view shows its unavailable state.
  'https://chains-news.johnaverse.cc', 'wss://chains-news.johnaverse.cc'
];
import { chainsRoutes } from './routes/chains.js';
import { relationsRoutes } from './routes/relations.js';
import { endpointsRoutes } from './routes/endpoints.js';
import { slip44Routes } from './routes/slip44.js';
import { rpcMonitorRoutes } from './routes/rpcMonitor.js';
import { clientsRoutes } from './routes/clients.js';
import { scalingRoutes } from './routes/scaling.js';
import { statusPagesRoutes } from './routes/statusPages.js';
import { upgradesRoutes } from './routes/upgrades.js';
import { providersRoutes } from './routes/providers.js';
import { feedbackRoutes } from './routes/feedback.js';
import { adminRoutes } from './routes/admin.js';
import { metricsRoute } from './routes/metrics.js';
import { refresherRoute } from './routes/refresher.js';
import { summaryRoute } from './routes/summary.js';
import { rootRoute } from './routes/root.js';
import { assistantRoutes } from './routes/assistant.js';
import { prefetchAllPrices, startPriceRefresh } from '../../priceService.js';
import { logger } from '../util/logger.js';

function resolveCorsOrigin(value) {
  if (value === '*') return true;
  return value.split(',').map(s => s.trim());
}

/**
 * Map a JSON Schema validation failure into the project's `{ error: ... }`
 * envelope.
 *
 * Preferred path: schemas declare per-keyword messages via `errorMessage`
 * (ajv-errors). When that's present, ajv emits a synthetic error with
 * `keyword: 'errorMessage'` and the schema-author's message in `.message`.
 * For schemas that haven't been migrated yet, fall through to a generic
 * "Invalid {dataVar}" string. Routes can override on a per-route basis.
 */
function formatSchemaValidationError(errors, dataVar) {
  // Prefer the route-author's `errorMessage` when present.
  const authored = errors.find(e => e.keyword === 'errorMessage' && typeof e.message === 'string');
  if (authored) {
    const err = new Error(authored.message);
    err.statusCode = 400;
    return err;
  }
  // additionalProperties needs the offending name interpolated; route
  // authors can't put `${...}` in their schema string, so handle here.
  const extra = errors.find(e => e.keyword === 'additionalProperties');
  if (extra) {
    const where = dataVar === 'querystring' ? 'query parameter' : 'field';
    const err = new Error(`Unknown ${where}: "${extra.params.additionalProperty}"`);
    err.statusCode = 400;
    return err;
  }
  const first = errors[0];
  const err = new Error(first.message || `Invalid ${dataVar}`);
  err.statusCode = 400;
  return err;
}

// Group every route under an OpenAPI tag derived from its first path segment,
// so the generated spec / Swagger UI is organized without each route file
// having to declare `schema.tags` by hand.
const TAG_BY_SEGMENT = {
  chains: 'Chains',
  search: 'Chains',
  relations: 'Relations',
  endpoints: 'Endpoints',
  slip44: 'SLIP-44',
  'rpc-monitor': 'RPC Monitor',
  clients: 'Clients',
  scaling: 'Scaling',
  'status-pages': 'Status Pages',
  keywords: 'Keywords',
  validate: 'Validation',
  stats: 'Stats',
  metrics: 'Observability',
  refresher: 'Observability',
  health: 'Meta',
  sources: 'Meta',
  export: 'Meta',
  summary: 'Meta',
  reload: 'Admin',
  assistant: 'Assistant',
  feedback: 'Feedback'
};

function tagForUrl(url) {
  const segment = url.split('?')[0].split('/').filter(Boolean)[0];
  return TAG_BY_SEGMENT[segment] || 'Meta';
}

// @fastify/swagger transform: hide non-API surfaces (static UI, the raw spec
// route) and auto-tag everything else.
function openapiTransform({ schema, url }) {
  const next = { ...(schema || {}) };
  if (url.startsWith('/ui') || url === '/openapi.json') {
    next.hide = true;
  } else if (!next.tags) {
    next.tags = [tagForUrl(url)];
  }
  return { schema: next, url };
}

const OPENAPI_TAGS = [
  { name: 'Chains', description: 'Chain metadata, search, and lookup' },
  { name: 'Relations', description: 'L2 / testnet / parent relationships and graph traversal' },
  { name: 'Endpoints', description: 'RPC, firehose, and substreams endpoints per chain' },
  { name: 'RPC Monitor', description: 'Live RPC endpoint health results' },
  { name: 'Clients', description: 'Execution-client registry and versions' },
  { name: 'Scaling', description: 'L2BEAT scaling data (stage, category, DA layer, TVS)' },
  { name: 'Status Pages', description: 'Curated operator status/incident pages' },
  { name: 'SLIP-44', description: 'SLIP-0044 coin-type registry' },
  { name: 'Keywords', description: 'Indexed search keywords' },
  { name: 'Validation', description: 'Cross-source validation rules' },
  { name: 'Stats', description: 'Aggregate counts' },
  { name: 'Observability', description: 'Prometheus metrics and refresher status' },
  { name: 'Admin', description: 'Data reload' },
  { name: 'Assistant', description: 'LLM chat assistant over the chains registry and live incidents' },
  { name: 'Feedback', description: 'User reports of wrong or misattributed information' },
  { name: 'Meta', description: 'Service info, health, and data sources' }
];

export async function buildApp(options = {}) {
  const {
    logger = true,
    bodyLimit = BODY_LIMIT,
    maxParamLength = MAX_PARAM_LENGTH,
    loadDataOnStartup = true
  } = options;

  const fastify = Fastify({
    logger,
    bodyLimit,
    maxParamLength,
    schemaErrorFormatter: formatSchemaValidationError,
    ajv: {
      customOptions: {
        removeAdditional: false,
        useDefaults: true,
        coerceTypes: 'array',
        allErrors: true   // required for ajv-errors to inspect all violations
      },
      plugins: [ajvErrors]
    }
  });

  fastify.setErrorHandler((error, _request, reply) => {
    // 4xx: validation errors are safe to surface to clients.
    if (error.validation || error.statusCode === 400) {
      return reply.code(400).send({ error: error.message });
    }
    // 5xx: log full detail server-side, return generic message to client.
    // Prevents leaking internal stack/file paths and database queries.
    const statusCode = error.statusCode || 500;
    fastify.log.error(error);
    if (statusCode >= 500) {
      return reply.code(statusCode).send({ error: 'Internal Server Error' });
    }
    return reply.code(statusCode).send({ error: error.message || 'Error' });
  });

  // OpenAPI: registered before the route plugins so its onRoute hook captures
  // every route's JSON Schema. Routes are auto-tagged by path via the transform.
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Chains API',
        description: 'Aggregated blockchain chain data from five external sources '
          + '(TheGraph, Chainlist, Chain ID Network, SLIP-0044, L2BEAT): chain metadata, '
          + 'relations, RPC endpoints and health, L2 scaling, and operator status.',
        version: pkg.version
      },
      servers: [
        { url: 'https://chains-api.johnaverse.cc', description: 'Production' },
        { url: 'http://localhost:3000', description: 'Local' }
      ],
      tags: OPENAPI_TAGS
    },
    transform: openapiTransform
  });

  await fastify.register(cors, {
    origin: resolveCorsOrigin(CORS_ORIGIN),
    credentials: false
  });

  // Origin-side response compression. Multi-MB JSON payloads (/export,
  // /chains, /summary) shrink ~85% under gzip/brotli. A CDN may compress at
  // its edge, but the origin→edge hop and direct clients benefit either way.
  await fastify.register(compress, { threshold: 1024 });

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        fontSrc: ["'self'"],
        // The /ui dashboard talks to the first-party live feeds (incidents
        // WS + forum news REST) — without these, the API-served copy of the
        // dashboard silently loses those panels (GitHub Pages, which serves
        // the production dashboard, sends no CSP and was never affected).
        // These are the BROWSER's feed origins and must match the
        // STATUS_NEWS_BASE / FORUM_NEWS_BASE constants in public/app.js — NOT
        // the LIVE_INCIDENTS_URL / FORUM_NEWS_URL env vars, which only point
        // the server-side assistant tools at a feed and never move the static
        // client (so coupling CSP to them would block the client on override).
        connectSrc: ["'self'", ...DASHBOARD_FEED_ORIGINS],
        imgSrc: ["'self'", 'data:']
      }
    }
  });

  // Swagger UI ships an inline bootstrap script/style that the API's strict CSP
  // would block. Relax CSP for the docs surface only — everything else (the API
  // and the /ui dashboard) keeps the hardened policy.
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/docs')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; base-uri 'self'; script-src 'self' 'unsafe-inline'; "
        + "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:"
      );
    }
    return payload;
  });

  // Serve public/ directory for the 3D visualization UI.
  // Resolve relative to the project root (two levels up from src/http/).
  const __dir = dirname(toFilePath(import.meta.url));
  await fastify.register(fastifyStatic, {
    root: join(__dir, '..', '..', 'public'),
    prefix: '/ui/',
    decorateReply: false
  });

  await fastify.register(rateLimit, {
    max: RATE_LIMIT_MAX,
    timeWindow: RATE_LIMIT_WINDOW_MS,
    // Probe endpoints must never be rate-limited. A 429 on /ready reads to kubelet as
    // "not ready", which removes the pod from the Service — so an exhausted bucket would
    // turn a traffic spike into a self-inflicted outage. /health has the same problem via
    // the liveness probe, where a 429 gets the container restarted.
    // Matched on the path, not request.url: the latter carries the query string, so a probe
    // configured with any parameter would silently fall back into the limited bucket.
    allowList: (request) => {
      const path = (request.url ?? '').split('?')[0];
      return path === '/health' || path === '/ready';
    }
  });

  if (loadDataOnStartup) {
    await initializeDataOnStartup({
      onBackgroundRefreshSuccess: () => {
        startRpcHealthCheck();
        startL2BeatRefresh();
      }
    });
    startRpcHealthCheck();
    startL2BeatRefresh();
    startSourceRefresher();
    // Warm the price cache now so the first /chains request doesn't pay a CoinGecko
    // round-trip, then keep it warm on a timer. Without the timer, entries expire after
    // PRICE_CACHE_TTL_MS and the next caller to touch an expired one waits on the fetch.
    // Failures are silent either way — a cold cache falls back to per-request fetching with
    // the same timeout.
    prefetchAllPrices().catch(err => {
      logger.warn({ err: err.message }, 'Initial price prefetch failed');
    });
    startPriceRefresh();
  }

  await fastify.register(adminRoutes);
  await fastify.register(chainsRoutes);
  await fastify.register(relationsRoutes);
  await fastify.register(endpointsRoutes);
  await fastify.register(slip44Routes);
  await fastify.register(rpcMonitorRoutes);
  await fastify.register(clientsRoutes);
  await fastify.register(scalingRoutes);
  await fastify.register(statusPagesRoutes);
  await fastify.register(upgradesRoutes);
  await fastify.register(providersRoutes);
  await fastify.register(feedbackRoutes);
  await fastify.register(metricsRoute);
  await fastify.register(refresherRoute);
  await fastify.register(summaryRoute);
  await fastify.register(assistantRoutes);
  await fastify.register(rootRoute);

  // Interactive docs at /docs and the raw machine-readable spec at /openapi.json.
  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true }
  });
  fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger());

  return fastify;
}
