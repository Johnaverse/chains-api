import { logger } from '../util/logger.js';
import { incCounter, observeHistogram } from '../util/metrics.js';

/**
 * API usage audit: one structured line per request ("api access", in the pod logs Loki keeps)
 * and Prometheus counters and latency by route and client kind (chains_api_http_*), shared by
 * the REST server and the MCP endpoint (mcp-server-http.js).
 *
 * The line carries who asked (IP, country, user agent, referrer), what (route template, the
 * raw path, chain ID) and how it went (status, milliseconds). Metrics never carry an IP or a
 * raw path: their labels stay bounded (route templates, not URLs).
 */

// Probes and the scrape itself: kubelet and Prometheus, every few seconds, never usage.
const UNAUDITED = new Set(['/health', '/ready', '/metrics']);
const UA_MAX = 300;

/**
 * The client's address. Behind Cloudflare and the ingress the socket peer is the ingress pod;
 * Cloudflare's CF-Connecting-IP is the visitor, else the first X-Forwarded-For hop.
 */
export function clientIp(headers = {}, fallback = null) {
  const cf = headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = headers['x-forwarded-for'];
  const first = typeof xff === 'string' ? xff.split(',')[0].trim() : '';
  return first || fallback || null;
}

/**
 * What kind of client asked, from what it sends rather than from a list of products:
 *   dashboard — our own dashboard (a page under /ui on this host, or the CORS origin it runs on);
 *   browser   — another page in a browser (it sends Fetch Metadata, sec-fetch-*);
 *   bot       — a self-declared crawler or bot;
 *   script    — anything else: curl, SDKs, servers, other services.
 */
export function clientKind(headers = {}, { dashboardOrigins = [] } = {}) {
  const ua = String(headers['user-agent'] ?? '');
  const origin = String(headers.origin ?? '');
  const referer = String(headers.referer ?? '');
  const host = String(headers.host ?? '');
  const fromDashboard = dashboardOrigins.some(o => o && (origin === o || referer.startsWith(`${o}/`)))
    || (host && referer.includes(`://${host}/ui`));
  if (fromDashboard) return 'dashboard';
  if (/\b(bot|crawler|spider)\b|bot\//i.test(ua)) return 'bot';
  if (headers['sec-fetch-mode'] || headers['sec-fetch-site']) return 'browser';
  return 'script';
}

function hostOf(url) {
  try { return new URL(url).host || null; } catch { return null; }
}

function statusClass(status) {
  return `${Math.floor(Number(status) / 100)}xx`;
}

/** The audit fields shared by REST and MCP lines. */
export function auditFields(headers, { ip = null, dashboardOrigins = [] } = {}) {
  return {
    ip: clientIp(headers, ip),
    country: headers['cf-ipcountry'] ?? null,
    kind: clientKind(headers, { dashboardOrigins }),
    ua: headers['user-agent'] ? String(headers['user-agent']).slice(0, UA_MAX) : null,
    referer: headers.referer ? hostOf(headers.referer) : null,
    origin: headers.origin ?? null
  };
}

/**
 * Audit every REST request on its response: the line and the metrics. Fastify's own
 * per-request logging is off (app.js), so this is the one record of each request.
 */
export function registerAccessLog(fastify, { dashboardOrigins = [] } = {}) {
  fastify.addHook('onResponse', async (request, reply) => {
    const path = (request.url ?? '').split('?')[0];
    if (UNAUDITED.has(path)) return;
    // The template ("/chains/:id"), so metrics stay bounded; static files and unmatched
    // paths (scanners) are grouped.
    const template = request.routeOptions?.url;
    const route = !template ? 'unmatched' : template.startsWith('/ui') ? '/ui/*' : template;
    const ms = reply.elapsedTime;
    const fields = auditFields(request.headers, { ip: request.ip, dashboardOrigins });
    const params = request.params ?? {};
    const chainId = params.id ?? params.chainId ?? request.query?.chainId ?? null;
    logger.info({
      audit: 'api',
      method: request.method,
      route,
      path: path.slice(0, 512),
      status: reply.statusCode,
      ms: Math.round(ms * 10) / 10,
      ...(chainId != null ? { chainId: String(chainId) } : {}),
      ...fields
    }, 'api access');
    const labels = { route, method: request.method, status: statusClass(reply.statusCode), kind: fields.kind };
    incCounter('chains_api_http_requests_total', labels);
    observeHistogram('chains_api_http_request_duration_seconds', { route, method: request.method }, ms / 1000);
  });
}

/**
 * Audit every MCP HTTP request (Express): the JSON-RPC method and, for tools/call, the tool.
 * Mounted before the MCP handlers in mcp-server-http.js.
 */
export function mcpAccessLog({ dashboardOrigins = [] } = {}) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const calls = Array.isArray(body) ? body : [body];
      const rpc = calls.map(c => c?.method).filter(Boolean);
      const tools = calls.filter(c => c?.method === 'tools/call').map(c => String(c?.params?.name ?? 'unknown'));
      const fields = auditFields(req.headers, { ip: req.socket?.remoteAddress ?? null, dashboardOrigins });
      logger.info({
        audit: 'mcp',
        method: req.method,
        route: req.path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        rpc: rpc.length ? rpc : null,
        ...(tools.length ? { tools } : {}),
        session: req.headers['mcp-session-id'] ?? null,
        ...fields
      }, 'mcp access');
      const status = statusClass(res.statusCode);
      incCounter('chains_api_http_requests_total', { route: `mcp:${req.path}`, method: req.method, status, kind: fields.kind });
      observeHistogram('chains_api_http_request_duration_seconds', { route: `mcp:${req.path}`, method: req.method }, ms / 1000);
      for (const m of rpc) incCounter('chains_api_mcp_rpc_total', { rpc: m, status });
      for (const tool of tools) incCounter('chains_api_mcp_tool_calls_total', { tool, status });
    });
    next();
  };
}
