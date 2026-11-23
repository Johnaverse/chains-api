import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import Fastify from 'fastify';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
// Imported here, not inside a test: the configuration tests reset the module registry, and a
// later import would get a second copy of the telemetry module with no provider.
import { buildApp } from '../../../src/http/app.js';
import {
  startTelemetry, stopTelemetry, tracingOn, withSpan, jobSpan, rpcSpan, tracedFetch, tracedPool,
  traceMcp, traceRequests, openSpan, detached, logIds, safePath, setActive, withLogIds
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
    // The standard flag, read as OpenTelemetry reads it.
    for (const off of ['TRUE', ' True ', 'true']) expect((await config({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318', OTEL_SDK_DISABLED: off })).OTEL_ENABLED).toBe(false);
    expect((await config({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318', OTEL_SDK_DISABLED: 'false' })).OTEL_ENABLED).toBe(true);
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
    // A key in letters only, a percent-escaped one, a short one, one that cannot be decoded.
    expect(safePath('/v2/AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf')).toBe('/v2/:key');
    expect(safePath('/v2/abcdefghijklmnopqrstuvwxyzabcdef')).toBe('/v2/:key');
    expect(safePath('/v3/%39aa3d95b3bc440fa88ea12eaa4456161')).toBe('/v3/:key');
    expect(safePath('/rpc/Xk3pQ9')).toBe('/rpc/:key');
    expect(safePath('/rpc/%E0%A4%A')).toBe('/rpc/:key');
    // Route words stay readable.
    expect(safePath('/api/scaling/summary')).toBe('/api/scaling/summary');
    expect(safePath('/chain-registry-production/chains.json')).toBe('/chain-registry-production/chains.json');
    expect(safePath('/satoshilabs/slips/master/slip-0044.md')).toBe('/satoshilabs/slips/master/slip-0044.md');
    expect(safePath('/v1/chat/completions')).toBe('/v1/chat/completions');
    expect(safePath('/')).toBe('/');
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
  const request = (body, headers = {}, path = '/mcp', method = 'POST') => ({ method, path, body, headers });
  const response = (statusCode = 200) => Object.assign(new EventEmitter(), { statusCode });
  const mcp = (trusted = () => true) => traceMcp({ paths: ['/mcp', '/mcp/pay'], tools: () => ['get_chain_by_id', 'get_chains'], trusted });
  const run = (req, res = response()) => { let inside; mcp()(req, res, () => { inside = logIds(); }); res.emit('close'); return inside; };

  it('are named by JSON-RPC method and tool, and continue the caller\'s trace', async () => {
    await traced();
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const inside = run(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_chain_by_id', arguments: { chainId: 1 } } }, { traceparent: `00-${traceId}-b7ad6b7169203331-01`, 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'agent/1' }));
    const span = named('tools/call get_chain_by_id');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(inside.trace_id).toBe(traceId);
    expect(span.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/mcp', 'rpc.system': 'jsonrpc', 'rpc.method': 'tools/call', 'mcp.tool.name': 'get_chain_by_id', 'http.response.status_code': 200 });
    // Neither who asked nor what they passed.
    expect(JSON.stringify(span.attributes)).not.toMatch(/203\.0\.113|agent\/1|chainId/);
  });

  it('record a method or tool they do not know as other / unknown, whatever was sent', async () => {
    await traced();
    const huge = 'x'.repeat(100000);
    run(request({ method: `tools/${huge}` }));
    run(request({ method: 'tools/call', params: { name: huge } }));
    run(request({ method: 'tools/call', params: { name: { not: 'a string' } } }));
    run(request({ method: 'tools/call' }));
    expect(spans().map(span => span.name)).toEqual(['other', 'tools/call unknown', 'tools/call unknown', 'tools/call unknown']);
    expect(spans()[0].attributes['rpc.method']).toBe('other');
    expect(JSON.stringify(spans().map(span => [span.name, span.attributes])).length).toBeLessThan(2000);
  });

  it('trace the MCP paths only: an unmatched path is never on a span', async () => {
    await traced();
    const next = vi.fn();
    for (const path of ['/unknown/private-token-9f8e7d', '/health', '/', '/mcp/other']) mcp()(request(null, {}, path, 'GET'), response(), next);
    expect(next).toHaveBeenCalledTimes(4);
    expect(spans()).toEqual([]);
    // A trailing slash is the same route.
    run(request([{ method: 'tools/list' }, { method: 'ping' }], {}, '/mcp/pay/'));
    expect(named('POST /mcp/pay').attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/mcp/pay', 'mcp.batch': 2, 'http.response.status_code': 200 });
    run(request(undefined, {}, '/mcp', 'GET'), response(500));
    expect(named('GET /mcp').status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('review hardening', () => {
  it('records a failure by its category, never its message or stack', async () => {
    await traced();
    const echoed = Object.assign(new Error('invalid project id 9aa3d95b3bc440fa88ea12eaa4456161 for params ["0xsecret"]'), { kind: 'rpc_error' });
    await withSpan('request', {}, () => rpcSpan('https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161', 'eth_call', async () => { throw echoed; })).catch(() => {});
    await withSpan('odd', {}, async () => { throw Object.assign(new Error('x'), { kind: 'a kind with spaces and 9aa3d95b' }); }).catch(() => {});
    const rpc = named('rpc eth_call');
    expect(rpc.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(rpc.attributes['error.type']).toBe('rpc_error');
    expect(rpc.events).toEqual([]);
    expect(named('odd').attributes['error.type']).toBe('Error');
    const exported = JSON.stringify(spans().map(span => [span.name, span.attributes, span.status, span.events]));
    expect(exported).not.toMatch(/9aa3d95b|0xsecret|invalid project/);
  });

  it('keeps a model\'s tag and namespace in its name', async () => {
    await traced();
    const ask = model => tracedFetch(async () => ok())('http://litellm.litellm.svc:4000/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model }) });
    await withSpan('request', {}, async () => { for (const model of ['qwen3:latest', 'pinax/qwen3.8-flash-next', 'org/model@v2', 'gpt-6-luna']) await ask(model); });
    expect(spans().filter(span => span.kind === SpanKind.CLIENT).map(span => span.attributes['gen_ai.request.model'])).toEqual(['qwen3:latest', 'pinax/qwen3.8-flash-next', 'org/model@v2', 'gpt-6-luna']);
  });

  it('records an unusual JSON-RPC method or model name as a fixed label', async () => {
    await traced();
    await withSpan('request', {}, async () => {
      await rpcSpan('https://rpc.example', 'eth_call\n' + 'x'.repeat(5000), async () => 1);
      await tracedFetch(async () => ok())('http://litellm.litellm.svc:4000/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm '.repeat(4000), max_tokens: 'many' }) });
    });
    expect(spans().map(span => span.name)).toEqual(['rpc other', 'chat model', 'request']);
    expect(named('chat model').attributes['gen_ai.request.max_tokens']).toBeUndefined();
  });

  it('sends the trace context to a cluster service however it is addressed', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    const internal = ['http://chains-news.chains-api.svc.cluster.local.:8080/x', 'http://CHAINS-NEWS.chains-api.svc:8080/x', 'http://10.43.12.7:8080/x', 'http://172.20.0.5/x', 'http://192.168.100.1/x', 'http://chains-news:8080/x'];
    const external = ['https://10.example.com/x', 'https://192.168.example.com/x', 'https://172.16.example.com/x', 'https://172.32.0.1/x', 'https://8.8.8.8/x'];
    await withSpan('request', {}, async () => { for (const url of [...internal, ...external]) await tracedFetch(fetcher)(url, { headers: {} }); });
    const sent = fetcher.mock.calls.map(([, init]) => Boolean(init.headers.traceparent));
    expect(sent).toEqual([...internal.map(() => true), ...external.map(() => false)]);
  });

  it('does not take a public name that starts like a loopback address for a local one', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    await withSpan('request', {}, async () => {
      await tracedFetch(fetcher)('https://127.example.com/x', { headers: {} });
      await tracedFetch(fetcher)('https://svc.example.com/x', { headers: {} });
      await tracedFetch(fetcher)('http://127.0.0.1:8080/x', { headers: {} });
    });
    const [lookalike, alsoPublic, loopback] = fetcher.mock.calls.map(([, init]) => init.headers);
    expect(lookalike).toEqual({});
    expect(alsoPublic).toEqual({});
    expect(loopback.traceparent).toBeDefined();
  });

  it('keeps the trace context through a request body that arrives late', async () => {
    await traced();
    const app = Fastify();
    traceRequests(app);
    let seen;
    let received;
    app.post('/echo', async (request) => { seen = logIds(); received = request.body; return { ok: true }; });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const encode = text => new TextEncoder().encode(text);
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(encode('{"a":'));
          await new Promise(resolve => setTimeout(resolve, 30));
          controller.enqueue(encode('1}'));
          controller.close();
        }
      });
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' });
      expect(await response.json()).toEqual({ ok: true });
      expect(received).toEqual({ a: 1 });
    } finally {
      await app.close();
    }
    expect(seen.trace_id).toBe(named('POST /echo').spanContext().traceId);
  });

  it('does not take an IPv6 literal for a service in the cluster', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    await withSpan('request', {}, async () => {
      await tracedFetch(fetcher)('http://[2606:4700:4700::1111]/x', { headers: {} });
      await tracedFetch(fetcher)('http://[::1]:8080/x', { headers: {} });
      await tracedFetch(fetcher)('http://chains-client-feed:8080/x', { headers: {} });
    });
    const [publicV6, loopback, bare] = fetcher.mock.calls.map(([, init]) => init.headers);
    expect(publicV6).toEqual({});
    expect(loopback.traceparent).toBeDefined();
    expect(bare.traceparent).toBeDefined();
  });

  it('passes an unsampled trace on to services in the cluster, without recording it', async () => {
    await traced({ sampleRatio: 0 });
    const fetcher = vi.fn(async () => ok());
    let traceId;
    await withSpan('request', {}, async (span) => {
      traceId = span.spanContext().traceId;
      await tracedFetch(fetcher)('http://chains-client-feed.chains-api.svc.cluster.local:8080/releases', { headers: { accept: 'application/json' } });
      await tracedFetch(fetcher)('https://l2beat.com/api', { headers: { accept: 'application/json' } });
    });
    expect(spans()).toEqual([]);
    expect(fetcher.mock.calls[0][1].headers).toEqual({ accept: 'application/json', traceparent: expect.stringMatching(new RegExp(`^00-${traceId}-[0-9a-f]{16}-00$`)) });
    expect(fetcher.mock.calls[1][1].headers).toEqual({ accept: 'application/json' });
  });

  it('sends nothing from inside a job whose calls are not traced', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    const init = { headers: {} };
    await jobSpan('rpc sweep', {}, () => tracedFetch(fetcher)('http://chains-client-feed:8080/x', init));
    expect(fetcher).toHaveBeenCalledWith('http://chains-client-feed:8080/x', init);
  });

  it('adds the trace ids to a logger\'s options without replacing what the caller set', async () => {
    expect(withLogIds(false)).toBe(false);
    expect(withLogIds(undefined)).toBeUndefined();
    expect(withLogIds(true)).toEqual({ mixin: logIds });
    const instance = { child: () => instance };
    expect(withLogIds(instance)).toBe(instance);
    const own = withLogIds({ level: 'debug', mixin: () => ({ app: 'x', trace_id: 'mine' }) });
    expect(own.level).toBe('debug');
    expect(own.mixin()).toEqual({ app: 'x', trace_id: 'mine' });
    await traced();
    await withSpan('work', {}, async (span) => {
      expect(own.mixin()).toEqual({ app: 'x', trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
    });
  });
});

describe('second review', () => {
  it('keeps the caller\'s headers in whichever form they were given', async () => {
    await traced();
    const fetcher = vi.fn(async () => ok());
    const fetch = tracedFetch(fetcher);
    const url = 'http://chains-client-feed.chains-api.svc.cluster.local:8080/releases';
    const given = new Headers({ authorization: 'Bearer t', accept: 'application/json' });
    await withSpan('request', {}, async () => {
      await fetch(url, { headers: given });
      await fetch(url, { headers: [['authorization', 'Bearer t'], ['accept', 'application/json']] });
      await fetch(url, { headers: { authorization: 'Bearer t' } });
      await fetch(url);
    });
    const sent = fetcher.mock.calls.map(([, init]) => init.headers);
    for (const headers of sent.slice(0, 2)) {
      expect(headers).toBeInstanceOf(Headers);
      expect(headers.get('authorization')).toBe('Bearer t');
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    }
    // The caller's own object is not written to.
    expect(given.has('traceparent')).toBe(false);
    expect(sent[2]).toEqual({ authorization: 'Bearer t', traceparent: expect.any(String) });
    expect(sent[3]).toEqual({ traceparent: expect.any(String) });
  });

  it('traces work that outlives the request that started it under a span of its own', async () => {
    await traced();
    const fetch = tracedFetch(async () => ok());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let job;
    // The request answers (its span ends) while the job is still running.
    await withSpan('POST /assistant/chat', {}, async () => {
      job = withSpan('assistant run', {}, async () => { await gate; await fetch('https://l2beat.com/api'); });
    });
    release();
    await job;
    const run = named('assistant run');
    expect(parentOf(run)).toBe(named('POST /assistant/chat').spanContext().spanId);
    expect(parentOf(named('GET'))).toBe(run.spanContext().spanId);
  });

  it('sends no trace context to an RPC endpoint when the trace is not sampled either', async () => {
    await traced({ sampleRatio: 0 });
    const fetcher = vi.fn(async () => ok({ result: '0x1' }));
    const init = { method: 'POST', headers: { 'content-type': 'application/json' } };
    await withSpan('request', {}, () => rpcSpan('http://ethereum-rpc:8545', 'eth_chainId', () => tracedFetch(fetcher)('http://ethereum-rpc:8545', init)));
    // And with no trace around the call at all.
    await rpcSpan('http://ethereum-rpc:8545', 'eth_chainId', () => tracedFetch(fetcher)('http://ethereum-rpc:8545', init));
    expect(fetcher.mock.calls.map(([, sent]) => sent)).toEqual([init, init]);
    expect(spans()).toEqual([]);
  });

  it('holds a sweep open across ticks as one root span, closed once with its totals', async () => {
    expect(openSpan('rpc sweep').end()).toBeUndefined();
    await traced();
    const fetch = tracedFetch(async () => ok());
    await withSpan('unrelated request', {}, async () => {
      const sweep = openSpan('rpc sweep', { 'rpc.sweep.number': 4, 'rpc.sweep.jobs': 120 });
      // Not the active span: a call made meanwhile belongs to the request it is made in.
      await fetch('https://l2beat.com/api');
      sweep.end({ 'rpc.sweep.completed': true, 'rpc.sweep.endpoints_checked': 900 });
      sweep.end({ 'rpc.sweep.completed': false });
    });
    const sweep = named('rpc sweep');
    expect(parentOf(sweep)).toBeNull();
    expect(sweep.attributes).toEqual({ 'rpc.sweep.number': 4, 'rpc.sweep.jobs': 120, 'rpc.sweep.completed': true, 'rpc.sweep.endpoints_checked': 900 });
    expect(parentOf(named('GET'))).toBe(named('unrelated request').spanContext().spanId);
    expect(spans().filter(span => span.name === 'rpc sweep')).toHaveLength(1);
  });

  it('ends a request\'s span when its connection closes, if nothing else did', async () => {
    await traced();
    const hooks = {};
    traceRequests({ addHook: (name, fn) => { hooks[name] = fn; } });
    const request = { method: 'GET', url: '/chains', headers: {}, routeOptions: { url: '/chains' } };
    const raw = new EventEmitter();
    hooks.onRequest(request, { raw }, () => {});
    raw.emit('close');
    expect(spans().map(span => [span.name, span.attributes['http.request.aborted']])).toEqual([['GET', true]]);
    // A response that was sent first is recorded as that, and the close after it adds nothing.
    const answered = { method: 'GET', url: '/chains', headers: {}, routeOptions: { url: '/chains' } };
    const raw2 = new EventEmitter();
    hooks.onRequest(answered, { raw: raw2 }, () => {});
    hooks.onResponse(answered, { statusCode: 200 }, () => {});
    raw2.emit('close');
    expect(spans()).toHaveLength(2);
    expect(spans()[1].attributes).toEqual({ 'http.request.method': 'GET', 'http.route': '/chains', 'http.response.status_code': 200 });
  });

  it('ends the span of a request the client abandoned, once', async () => {
    await traced();
    const hooks = {};
    traceRequests({ addHook: (name, fn) => { hooks[name] = fn; } });
    const request = { method: 'POST', url: '/assistant/chat', headers: {}, routeOptions: { url: '/assistant/chat' } };
    hooks.onRequest(request, {}, () => {});
    hooks.onRequestAbort(request, () => {});
    // Nothing left to finish if a response hook fires afterwards.
    hooks.onResponse(request, { statusCode: 200 }, () => {});
    hooks.onRequestAbort(request, () => {});
    expect(spans()).toHaveLength(1);
    expect(spans()[0].attributes).toEqual({ 'http.request.method': 'POST', 'http.request.aborted': true });
    expect(spans()[0].status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('fourth review', () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const traceparent = `00-${traceId}-b7ad6b7169203331-01`;

  it('does not let a public caller choose the trace or force it to be recorded', async () => {
    await traced({ sampleRatio: 0 });
    const app = await buildApp({ logger: false, loadDataOnStartup: false });
    try {
      // Through Cloudflare or the gateway: the header claims "sampled", the ratio says none.
      await app.inject({ url: '/chains/1', headers: { traceparent, 'cf-connecting-ip': '203.0.113.9' } });
      await app.inject({ url: '/chains/1', headers: { traceparent, 'x-forwarded-for': '203.0.113.9' } });
      expect(spans()).toEqual([]);
      // From inside the cluster the caller's sampled trace is continued.
      await app.inject({ url: '/chains/1', headers: { traceparent } });
      expect(spans().map(span => span.spanContext().traceId)).toEqual([traceId]);
    } finally {
      await app.close();
    }
  });

  it('trusts only a caller that came straight from the cluster', async () => {
    const { directFromCluster } = await import('../../../src/http/accessLog.js');
    const publicHosts = ['chains-api.johnaverse.cc'];
    const inCluster = { host: 'chains-api.chains-api.svc.cluster.local:3000' };
    expect(directFromCluster(inCluster, '10.42.1.16', { publicHosts })).toBe(true);
    expect(directFromCluster(inCluster, '::ffff:10.42.1.16', { publicHosts })).toBe(true);
    // A public peer, any proxy header (even empty), or the public hostname: not trusted.
    expect(directFromCluster(inCluster, '203.0.113.9', { publicHosts })).toBe(false);
    expect(directFromCluster(inCluster, null, { publicHosts })).toBe(false);
    for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'forwarded', 'x-real-ip']) {
      expect(directFromCluster({ ...inCluster, [name]: '203.0.113.9' }, '10.42.1.16', { publicHosts })).toBe(false);
      expect(directFromCluster({ ...inCluster, [name]: '' }, '10.42.1.16', { publicHosts })).toBe(false);
    }
    expect(directFromCluster({ host: 'chains-api.johnaverse.cc' }, '10.42.1.16', { publicHosts })).toBe(false);
    expect(directFromCluster({ host: 'CHAINS-API.johnaverse.cc:443' }, '10.42.1.16', { publicHosts })).toBe(false);
    for (const host of ['chains-api.johnaverse.cc.', 'chains-api.johnaverse.cc.:443', ' chains-api.johnaverse.cc.. ']) expect(directFromCluster({ host }, '10.42.1.16', { publicHosts })).toBe(false);
    expect(directFromCluster(inCluster, '10.42.1.16', { publicHosts: ['chains-api.johnaverse.cc.'] })).toBe(true);

    await traced({ sampleRatio: 0 });
    const app = await buildApp({ logger: false, loadDataOnStartup: false });
    try {
      for (const name of ['forwarded', 'x-real-ip']) await app.inject({ url: '/chains/1', headers: { traceparent, [name]: 'for=203.0.113.9' } });
      expect(spans()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('starts a new trace for an MCP request from a caller it does not trust', async () => {
    await traced();
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    traceMcp({ paths: ['/mcp'] })({ method: 'POST', path: '/mcp', body: { method: 'ping' }, headers: { traceparent } }, res, () => {});
    res.emit('close');
    expect(named('ping').spanContext().traceId).not.toBe(traceId);
    expect(parentOf(named('ping'))).toBeNull();
  });

  it('ends and sends what is still running when tracing stops', async () => {
    // An exporter that keeps what it was sent after shutdown (the in-memory one empties itself).
    const got = [];
    const sent = { getFinishedSpans: () => got };
    await startTelemetry({ serviceName: 'chains-api' }, { exporter: { export: (batch, done) => { got.push(...batch); done({ code: 0 }); }, shutdown: async () => {}, forceFlush: async () => {} }, logger: {} });
    const sweep = openSpan('rpc sweep', { 'rpc.sweep.number': 1 });
    let release;
    const run = withSpan('assistant run', {}, () => new Promise((resolve) => { release = resolve; }));
    await stopTelemetry();
    expect(sent.getFinishedSpans().map(span => [span.name, span.attributes.shutdown]).sort()).toEqual([['assistant run', true], ['rpc sweep', true]]);
    // Settling afterwards changes nothing and throws nothing.
    release();
    await run;
    sweep.end({ 'rpc.sweep.completed': false });
    expect(sent.getFinishedSpans()).toHaveLength(2);
  });
});

describe('fifth review', () => {
  it('follows a redirect itself, once, without the trace context', async () => {
    await traced();
    const url = 'http://chains-client-feed.chains-api.svc.cluster.local:8080/releases';
    const to = (status, location) => new Response(null, { status, headers: { location } });
    const run = (fetcher, init) => withSpan('request', {}, () => tracedFetch(fetcher)(url, init));

    // A GET redirected out of the cluster: followed to its Location, no context, no credentials.
    const get = vi.fn(async (_url, init) => (init?.redirect === 'manual' ? to(302, 'https://elsewhere.example/releases') : ok({ followed: true })));
    const response = await run(get, { headers: { accept: 'application/json', authorization: 'Bearer t' } });
    expect(await response.json()).toEqual({ followed: true });
    expect(get.mock.calls[0][0]).toBe(url);
    expect(get.mock.calls[0][1]).toMatchObject({ redirect: 'manual', headers: { authorization: 'Bearer t', traceparent: expect.any(String) } });
    expect(get.mock.calls[1][0]).toBe('https://elsewhere.example/releases');
    const followed = get.mock.calls[1][1].headers;
    expect([followed.get('accept'), followed.get('authorization'), followed.get('traceparent')]).toEqual(['application/json', null, null]);

    // A POST answered 303 has run: it is not sent again, its result is fetched with a GET.
    const post = vi.fn(async (_url, init) => (init?.redirect === 'manual' ? to(303, '/jobs/7') : ok({ job: 7 })));
    await run(post, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: '{"a":1}' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    const [target, next] = post.mock.calls[1];
    expect(target).toBe('http://chains-client-feed.chains-api.svc.cluster.local:8080/jobs/7');
    expect(next.method).toBe('GET');
    expect('body' in next).toBe(false);
    // Same origin: the credentials stay; the body's headers go with the body.
    expect([next.headers.get('authorization'), next.headers.get('content-type'), next.headers.get('traceparent')]).toEqual(['Bearer t', null, null]);

    // A 307 keeps its method and body.
    const keep = vi.fn(async (_url, init) => (init?.redirect === 'manual' ? to(307, '/v2/releases') : ok()));
    await run(keep, { method: 'POST', body: '{"a":1}' });
    expect(keep.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"a":1}' });

    // A 304 is an answer, even one that carries a Location.
    const notModified = vi.fn(async () => new Response(null, { status: 304, headers: { location: 'https://elsewhere.example/', etag: '"v1"' } }));
    const cached = await run(notModified, { headers: { 'if-none-match': '"v1"' } });
    expect(notModified).toHaveBeenCalledTimes(1);
    expect([cached.status, cached.headers.get('etag')]).toEqual([304, '"v1"']);

    // No redirect, one request; a 304 is an answer; the caller's own redirect mode is kept.
    const plain = vi.fn(async () => new Response(null, { status: 304 }));
    await run(plain, {});
    expect(plain).toHaveBeenCalledTimes(1);
    const own = vi.fn(async () => to(302, 'https://elsewhere.example/'));
    await run(own, { redirect: 'error' });
    expect(own).toHaveBeenCalledTimes(1);
    expect(own.mock.calls[0][1].redirect).toBe('error');
  });

  it('makes a second stop wait for the flush the first one started', async () => {
    let flushed = false;
    let finishFlush;
    const slow = { export: (_batch, done) => done({ code: 0 }), forceFlush: async () => {}, shutdown: () => new Promise((resolve) => { finishFlush = () => { flushed = true; resolve(); }; }) };
    await startTelemetry({ serviceName: 'chains-api' }, { exporter: slow, logger: {} });
    const first = stopTelemetry();
    let secondDone = false;
    const second = stopTelemetry().then(() => { secondDone = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(secondDone).toBe(false);
    finishFlush();
    await Promise.all([first, second]);
    expect(flushed).toBe(true);
    expect(secondDone).toBe(true);
    // And tracing can start again afterwards.
    await traced();
    expect(tracingOn()).toBe(true);
  });
});

describe('independent review', () => {
  it('stops waiting for a collector that never answers', async () => {
    vi.useFakeTimers();
    try {
      const hung = { export: (_batch, done) => done({ code: 0 }), forceFlush: async () => {}, shutdown: () => new Promise(() => {}) };
      await startTelemetry({ serviceName: 'chains-api' }, { exporter: hung, logger: {} });
      let stopped = false;
      const stop = stopTelemetry().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(2900);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await stop;
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes every argument of a query through, traced or not, on or off', async () => {
    const pool = { query: vi.fn(async () => []) };
    await tracedPool(pool).query('SELECT 1', [1], { timeout: 5 });
    await traced();
    await tracedPool(pool).query('SELECT 1', [1], { timeout: 5 });
    await withSpan('request', {}, () => tracedPool(pool).query('SELECT 1', [1], { timeout: 5 }));
    expect(pool.query.mock.calls).toEqual([['SELECT 1', [1], { timeout: 5 }], ['SELECT 1', [1], { timeout: 5 }], ['SELECT 1', [1], { timeout: 5 }]]);
  });

  it('starts a timer outside the trace of whatever started it', async () => {
    expect(detached(() => 7)).toBe(7);
    await traced();
    let inside;
    let outside;
    await withSpan('POST /reload', {}, async () => {
      inside = logIds();
      await new Promise((resolve) => { detached(() => setTimeout(() => { outside = logIds(); resolve(); }, 5)); });
    });
    expect(inside.trace_id).toBeDefined();
    expect(outside).toEqual({});
  });
});

describe('REST requests', () => {
  it('are named by route template, continue the caller\'s trace, and skip probes and the scrape', async () => {
    await traced();
    const app = await buildApp({ logger: false, loadDataOnStartup: false });
    try {
      const traceId = '0af7651916cd43dd8448eb211c80319c';
      // From another service in the cluster: no proxy header, a private peer address.
      await app.inject({ url: '/chains/1?x=1', headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01`, 'user-agent': 'agent/1' } });
      await app.inject('/health');
      await app.inject('/metrics');
      const server = spans().filter(span => span.kind === SpanKind.SERVER);
      expect(server.map(span => span.name)).toEqual(['GET /chains/:id']);
      expect(server[0].spanContext().traceId).toBe(traceId);
      expect(parentOf(server[0])).toBe('b7ad6b7169203331');
      expect(server[0].attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/chains/:id' });
      expect(typeof server[0].attributes['http.response.status_code']).toBe('number');
      // No address, no user agent, no raw path or query.
      expect(JSON.stringify(server[0].attributes)).not.toMatch(/agent\/1|x=1|chains\/1/);
    } finally {
      await app.close();
    }
  });
});
