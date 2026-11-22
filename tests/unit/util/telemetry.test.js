import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
// Imported here, not inside a test: the configuration tests reset the module registry, and a
// later import would get a second copy of the telemetry module with no provider.
import { buildApp } from '../../../src/http/app.js';
import {
  startTelemetry, stopTelemetry, tracingOn, withSpan, jobSpan, rpcSpan, tracedFetch, tracedPool,
  traceMcp, logIds, safePath, setActive
} from '../../../src/util/telemetry.js';

let exporter;
const traced = async (options = {}) => {
  exporter = new InMemorySpanExporter();
  await startTelemetry({ serviceName: 'chains-api', version: '9.9.9', ...options }, { exporter, logger: {} });
};
const spans = () => exporter.getFinishedSpans();
const named = name => spans().find(span => span.name === name);
const parentOf = span => span.parentSpanContext?.spanId ?? null;
const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200 });

const ENV = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_SDK_DISABLED', 'OTEL_SERVICE_NAME', 'OTEL_TRACES_SAMPLER_ARG'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
async function config(env) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  return import('../../../config.js');
}

afterEach(async () => {
  await stopTelemetry();
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

describe('configuration', () => {
  it('is off without an OTLP endpoint, on with one, and off again with OTEL_SDK_DISABLED', async () => {
    expect(await config({})).toMatchObject({ OTEL_ENABLED: false, OTEL_SERVICE_NAME: 'chains-api', OTEL_SAMPLE_RATIO: 1 });
    expect(await config({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318', OTEL_SERVICE_NAME: 'api', OTEL_TRACES_SAMPLER_ARG: '0.1' }))
      .toMatchObject({ OTEL_ENABLED: true, OTEL_SERVICE_NAME: 'api', OTEL_SAMPLE_RATIO: 0.1 });
    expect((await config({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://tempo:4318/v1/traces' })).OTEL_ENABLED).toBe(true);
    expect((await config({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318', OTEL_SDK_DISABLED: 'true' })).OTEL_ENABLED).toBe(false);
    expect((await config({ OTEL_TRACES_SAMPLER_ARG: 'lots' })).OTEL_SAMPLE_RATIO).toBe(1);
    expect((await config({ OTEL_TRACES_SAMPLER_ARG: '5' })).OTEL_SAMPLE_RATIO).toBe(1);
  });

  it('does nothing while off: work runs directly and calls are passed through', async () => {
    expect((await startTelemetry({ enabled: false })).enabled).toBe(false);
    expect(tracingOn()).toBe(false);
    expect(await withSpan('x', {}, async span => span)).toBeNull();
    expect(await jobSpan('x', {}, async span => span)).toBeNull();
    const fetcher = vi.fn(async () => ok());
    const init = { headers: { a: '1' } };
    await tracedFetch(fetcher)('http://feed.chains-api.svc.cluster.local:8080/releases', init);
    expect(fetcher).toHaveBeenCalledWith('http://feed.chains-api.svc.cluster.local:8080/releases', init);
    expect(await rpcSpan('https://rpc.example/v3/key', 'eth_chainId', async () => '0x1')).toBe('0x1');
    expect(logIds()).toEqual({});
  });

  it('names the service and version, and keeps the share of new traces asked for', async () => {
    await traced();
    await withSpan('x', {}, async () => {});
    expect(spans()[0].resource.attributes).toMatchObject({ 'service.name': 'chains-api', 'service.version': '9.9.9' });
    await traced({ sampleRatio: 0 });
    await withSpan('dropped', {}, async () => {});
    expect(spans()).toEqual([]);
  });
});

describe('outbound calls', () => {
  it('are recorded inside a traced request only', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    const fetch = tracedFetch(fetcher);
    await fetch('https://api.llama.fi/config');
    expect(spans()).toEqual([]);
    await withSpan('request', {}, () => fetch('https://api.llama.fi/config?x=1'));
    const get = named('GET');
    expect(get.kind).toBe(SpanKind.CLIENT);
    expect(parentOf(get)).toBe(named('request').spanContext().spanId);
    expect(get.attributes).toEqual({ 'http.request.method': 'GET', 'url.full': 'https://api.llama.fi/config', 'server.address': 'api.llama.fi', 'http.response.status_code': 200 });
  });

  it('keep keys out of the recorded URL', async () => {
    expect(safePath('/v3/9aa3d95b3bc440fa88ea12eaa4456161')).toBe('/v3/:key');
    expect(safePath('/v2/AbCdEfGh1234567890abcdEFGH')).toBe('/v2/:key');
    expect(safePath('/api/scaling/summary')).toBe('/api/scaling/summary');
    expect(safePath('/chain-registry-production/chains.json')).toBe('/chain-registry-production/chains.json');
    await traced();
    await withSpan('request', {}, () => tracedFetch(async () => ok())('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161?apikey=zzz'));
    expect(named('GET').attributes['url.full']).toBe('https://mainnet.infura.io/v3/:key');
    expect(JSON.stringify(spans().map(s => s.attributes))).not.toMatch(/9aa3d95b|zzz/);
  });

  it('carry the trace context to services in the cluster and to no one else', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    const fetch = tracedFetch(fetcher);
    await withSpan('request', {}, async () => {
      await fetch('http://chains-client-feed.chains-api.svc.cluster.local:8080/releases', { headers: { accept: 'application/json' } });
      await fetch('http://litellm.litellm.svc:4000/v1/models');
      await fetch('https://l2beat.com/api/scaling/summary', { headers: { accept: 'application/json' } });
    });
    const [feed, gateway, outside] = fetcher.mock.calls.map(([, init]) => init?.headers ?? {});
    const traceId = named('request').spanContext().traceId;
    expect(feed.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    expect(feed.accept).toBe('application/json');
    expect(gateway.traceparent).toContain(traceId);
    expect(outside).toEqual({ accept: 'application/json' });
  });

  it('name a model call and record its token usage, never the prompt or the answer', async () => {
    await traced();
    const fetcher = async () => ok({ model: 'qwen-served', usage: { prompt_tokens: 1200, completion_tokens: 80 }, choices: [{ message: { content: 'the answer text' }, finish_reason: 'stop' }] });
    const body = JSON.stringify({ model: 'qwen3', max_tokens: 900, messages: [{ role: 'user', content: 'the prompt text' }] });
    const response = await withSpan('request', {}, () => tracedFetch(fetcher)('http://litellm.litellm.svc:4000/v1/chat/completions', { method: 'POST', body }));
    // The caller still reads the answer.
    expect((await response.json()).choices[0].message.content).toBe('the answer text');
    const chat = named('chat qwen3');
    expect(chat.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'qwen3', 'gen_ai.request.max_tokens': 900, 'gen_ai.response.model': 'qwen-served',
      'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 80, 'gen_ai.response.finish_reasons': ['stop']
    });
    expect(JSON.stringify(spans().map(s => s.attributes))).not.toMatch(/prompt text|answer text/);
  });

  it('mark a refused call failed', async () => {
    await traced();
    await withSpan('request', {}, () => tracedFetch(async () => new Response('x', { status: 503 }))('https://l2beat.com/api'));
    expect(named('GET').status.code).toBe(SpanStatusCode.ERROR);
    expect(named('GET').attributes['http.response.status_code']).toBe(503);
  });

  it('record a JSON-RPC call by method and host, once', async () => {
    await traced();
    const fetch = tracedFetch(async () => ok({ result: '0x1' }));
    await rpcSpan('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', 'eth_chainId', () => fetch('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', { method: 'POST' }));
    expect(spans()).toEqual([]);
    await withSpan('request', {}, () => rpcSpan('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', 'eth_chainId', () => fetch('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', { method: 'POST' })));
    expect(spans().map(span => span.name).sort()).toEqual(['request', 'rpc eth_chainId']);
    expect(named('rpc eth_chainId').attributes).toEqual({ 'rpc.system': 'jsonrpc', 'rpc.method': 'eth_chainId', 'server.address': 'mainnet.infura.io' });
    const failing = Object.assign(new Error('RPC request timed out'), { kind: 'timeout' });
    await withSpan('request2', {}, () => rpcSpan('https://rpc.example', 'eth_blockNumber', async () => { throw failing; }).catch(() => {}));
    expect(named('rpc eth_blockNumber').attributes['error.type']).toBe('timeout');
  });
});

describe('jobs, database and logs', () => {
  it('record a background job as one span carrying its totals', async () => {
    await traced();
    const fetch = tracedFetch(async () => ok());
    await jobSpan('rpc sweep', { 'rpc.sweep.endpoints': 3 }, async (span) => {
      for (let i = 0; i < 3; i += 1) await rpcSpan(`https://rpc${i}.example`, 'eth_blockNumber', () => fetch(`https://rpc${i}.example`));
      span.setAttribute('rpc.sweep.working', 3);
    });
    expect(spans().map(span => span.name)).toEqual(['rpc sweep']);
    expect(named('rpc sweep').attributes).toEqual({ 'rpc.sweep.endpoints': 3, 'rpc.sweep.working': 3 });
  });

  it('record a query by statement inside a request, and leave the rest of the pool alone', async () => {
    await traced();
    const connection = { release: vi.fn() };
    const pool = { query: vi.fn(async () => [{ n: 1 }]), getConnection: vi.fn(async function () { return this === pool ? connection : null; }), end: vi.fn(async () => {}) };
    const wrapped = tracedPool(pool);
    expect(tracedPool(wrapped)).toBe(wrapped);
    await wrapped.query('SELECT 1');
    expect(spans()).toEqual([]);
    const rows = await withSpan('request', {}, () => wrapped.query('UPDATE x402_payments\n   SET state=? WHERE id=?', ['secret-value', 7]));
    expect(rows).toEqual([{ n: 1 }]);
    expect(pool.query).toHaveBeenLastCalledWith('UPDATE x402_payments\n   SET state=? WHERE id=?', ['secret-value', 7]);
    expect(named('db UPDATE').attributes).toEqual({ 'db.system.name': 'mariadb', 'db.query.summary': 'UPDATE x402_payments SET state=? WHERE id=?' });
    // Called on the pool itself, as the driver expects.
    expect(await wrapped.getConnection()).toBe(connection);
    await wrapped.end();
    expect(pool.end).toHaveBeenCalled();
  });

  it('give log lines the ids of the span they are written in', async () => {
    await traced();
    await withSpan('work', {}, async (span) => {
      expect(logIds()).toEqual({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
      setActive({ 'chains.count': 2, missing: null });
    });
    expect(named('work').attributes).toEqual({ 'chains.count': 2 });
    expect(logIds()).toEqual({});
  });
});

describe('MCP requests', () => {
  const request = (body, headers = {}, path = '/mcp') => ({ method: 'POST', path, body, headers });
  const response = (statusCode = 200) => Object.assign(new EventEmitter(), { statusCode });

  it('are named by JSON-RPC method and tool, and continue the caller\'s trace', async () => {
    await traced();
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const res = response();
    let inside;
    traceMcp()(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_chain_by_id', arguments: { chainId: 1 } } }, { traceparent: `00-${traceId}-b7ad6b7169203331-01`, 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'agent/1' }), res, () => { inside = logIds(); });
    res.emit('close');
    const span = named('tools/call get_chain_by_id');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(inside.trace_id).toBe(traceId);
    expect(span.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/mcp', 'rpc.system': 'jsonrpc', 'rpc.method': 'tools/call', 'mcp.tool.name': 'get_chain_by_id', 'http.response.status_code': 200 });
    // Neither who asked nor what they passed.
    expect(JSON.stringify(span.attributes)).not.toMatch(/203\.0\.113|agent\/1|chainId/);
  });

  it('cover a batch, a request without a body, a failure, and skip probes', async () => {
    await traced();
    const batch = response();
    traceMcp()(request([{ method: 'tools/list' }, { method: 'ping' }], {}, '/mcp/pay'), batch, () => {});
    batch.emit('close');
    expect(named('POST /mcp/pay').attributes).toMatchObject({ 'mcp.batch': 2, 'http.route': '/mcp/pay' });
    const failed = response(500);
    traceMcp()({ method: 'GET', path: '/mcp', headers: {} }, failed, () => {});
    failed.emit('close');
    expect(named('GET /mcp').status.code).toBe(SpanStatusCode.ERROR);
    const next = vi.fn();
    traceMcp()({ method: 'GET', path: '/health', headers: {} }, response(), next);
    expect(next).toHaveBeenCalled();
    expect(spans()).toHaveLength(2);
  });
});

describe('REST requests', () => {
  it('are named by route template, continue the caller\'s trace, and skip probes and the scrape', async () => {
    await traced();
    const app = await buildApp({ logger: false, loadDataOnStartup: false });
    try {
      const traceId = '0af7651916cd43dd8448eb211c80319c';
      await app.inject({ url: '/chains/1?x=1', headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01`, 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'agent/1' } });
      await app.inject('/health');
      await app.inject('/metrics');
      const server = spans().filter(span => span.kind === SpanKind.SERVER);
      expect(server.map(span => span.name)).toEqual(['GET /chains/:id']);
      expect(server[0].spanContext().traceId).toBe(traceId);
      expect(parentOf(server[0])).toBe('b7ad6b7169203331');
      expect(server[0].attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/chains/:id' });
      expect(typeof server[0].attributes['http.response.status_code']).toBe('number');
      // No address, no user agent, no raw path or query.
      expect(JSON.stringify(server[0].attributes)).not.toMatch(/203\.0\.113|agent\/1|x=1|chains\/1/);
    } finally {
      await app.close();
    }
  });
});
