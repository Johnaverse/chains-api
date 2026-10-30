import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { logger } from '../../../src/util/logger.js';
import { clientIp, clientKind, registerAccessLog, mcpAccessLog } from '../../../src/http/accessLog.js';
import { renderMetrics, _resetMetricsForTests } from '../../../src/util/metrics.js';

const DASH = ['https://www.johnaverse.cc'];
const metricsText = () => renderMetrics({ cache: {}, rpcStatus: {}, l2beatStatus: {}, validationSummary: null, incidentSummary: null, clientFeedCache: null });

beforeEach(() => { _resetMetricsForTests(); vi.restoreAllMocks(); });

describe('clientIp', () => {
  it('prefers Cloudflare, then the first forwarded hop, then the socket', () => {
    expect(clientIp({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' }, '10.42.0.1')).toBe('203.0.113.7');
    expect(clientIp({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }, '10.42.0.1')).toBe('198.51.100.2');
    expect(clientIp({}, '10.42.0.1')).toBe('10.42.0.1');
  });
});

describe('clientKind', () => {
  it('tells our dashboard, other browser pages, bots and scripts apart', () => {
    expect(clientKind({ origin: 'https://www.johnaverse.cc', 'sec-fetch-mode': 'cors' }, { dashboardOrigins: DASH })).toBe('dashboard');
    expect(clientKind({ host: 'chains-api.johnaverse.cc', referer: 'https://chains-api.johnaverse.cc/ui/chains/1' }, { dashboardOrigins: DASH })).toBe('dashboard');
    expect(clientKind({ origin: 'https://example.org', 'sec-fetch-mode': 'cors', 'user-agent': 'Mozilla/5.0' }, { dashboardOrigins: DASH })).toBe('browser');
    expect(clientKind({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' })).toBe('bot');
    expect(clientKind({ 'user-agent': 'curl/8.5.0' })).toBe('script');
  });

  it('reads another service in the cluster as internal, and Node fetch as no browser', () => {
    // A sibling feed: Node's fetch sends Fetch Metadata, straight to the pod.
    const nodeFetch = { 'user-agent': 'node', 'sec-fetch-mode': 'cors' };
    expect(clientKind(nodeFetch, { peer: '10.42.1.46' })).toBe('internal');
    expect(clientKind(nodeFetch, { peer: '::ffff:10.42.1.46' })).toBe('internal');
    // The same through Cloudflare is an outside script, not a browser.
    expect(clientKind({ ...nodeFetch, 'cf-connecting-ip': '203.0.113.7' }, { peer: '10.42.0.5' })).toBe('script');
  });
});

describe('REST audit', () => {
  async function app() {
    const fastify = Fastify({ logger: false, disableRequestLogging: true });
    registerAccessLog(fastify, { dashboardOrigins: DASH });
    fastify.get('/chains/:id', async () => ({ ok: true }));
    fastify.get('/health', async () => ({ ok: true }));
    await fastify.ready();
    return fastify;
  }

  it('logs one line per request with route, client and timing, and counts it', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const fastify = await app();
    await fastify.inject({ url: '/chains/1?x=1', headers: { 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'CA', 'user-agent': 'curl/8.5.0' } });
    const [fields, msg] = info.mock.calls.find(c => c[1] === 'api access');
    expect(msg).toBe('api access');
    expect(fields).toMatchObject({ audit: 'api', method: 'GET', route: '/chains/:id', path: '/chains/1', status: 200, chainId: '1', ip: '203.0.113.7', country: 'CA', kind: 'script', ua: 'curl/8.5.0' });
    expect(metricsText()).toContain('chains_api_http_requests_total{kind="script",method="GET",route="/chains/:id",status="2xx"} 1');
    expect(metricsText()).toContain('chains_api_http_request_duration_seconds_count{method="GET",route="/chains/:id"} 1');
    await fastify.inject({ url: '/chains/2', headers: { 'cf-connecting-ip': '203.0.113.7', origin: 'https://www.johnaverse.cc', 'sec-fetch-mode': 'cors', 'user-agent': 'Mozilla/5.0' } });
    const dash = info.mock.calls.filter(c => c[1] === 'api access').map(c => c[0]).find(f => f.path === '/chains/2');
    expect(dash).toMatchObject({ kind: 'dashboard', referer: null, site: 'www.johnaverse.cc' });
    await fastify.close();
  });

  it('leaves probes out and groups unmatched paths', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const fastify = await app();
    await fastify.inject({ url: '/health' });
    await fastify.inject({ url: '/wp-login.php' });
    const lines = info.mock.calls.filter(c => c[1] === 'api access').map(c => c[0]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: 'unmatched', path: '/wp-login.php', status: 404 });
    await fastify.close();
  });
});

describe('MCP audit', () => {
  it('logs the JSON-RPC method and tool, and counts tool calls', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const req = {
      method: 'POST', path: '/mcp', socket: { remoteAddress: '10.42.0.1' },
      headers: { 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'claude-code/2.1', 'mcp-session-id': 's1' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_chain_by_id', arguments: { chainId: 1 } } }
    };
    const next = vi.fn();
    mcpAccessLog({ dashboardOrigins: DASH })(req, res, next);
    expect(next).toHaveBeenCalled();
    res.emit('finish');
    const [fields] = info.mock.calls.find(c => c[1] === 'mcp access');
    expect(fields).toMatchObject({ audit: 'mcp', route: '/mcp', status: 200, rpc: ['tools/call'], tools: ['get_chain_by_id'], session: 's1', ip: '198.51.100.9', kind: 'script' });
    expect(metricsText()).toContain('chains_api_mcp_tool_calls_total{status="2xx",tool="get_chain_by_id"} 1');
  });
});
