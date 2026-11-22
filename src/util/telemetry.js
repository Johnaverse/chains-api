import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator, suppressTracing, isTracingSuppressed } from '@opentelemetry/core';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, ParentBasedSampler, SimpleSpanProcessor, TraceIdRatioBasedSampler, TracerProvider } from '@opentelemetry/sdk-trace';

/**
 * OpenTelemetry tracing. Off unless an OTLP endpoint is configured (OTEL_EXPORTER_OTLP_ENDPOINT
 * or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT): everything below is then a no-op and nothing is
 * loaded, sampled or sent.
 *
 * What is traced: an inbound REST request and an MCP request (server spans, continuing the
 * caller's trace), and under them the outbound HTTP, JSON-RPC, model and database calls they
 * cause. Background work is traced as one span per job (a data load, an RPC health sweep), not
 * per call: a sweep tests thousands of endpoints.
 *
 * What is kept off the spans: client addresses and user agents, query strings, request and
 * response bodies, prompts and answers, query values, and any URL path segment that looks like a
 * key (RPC URLs carry API keys in their path; a JSON-RPC span records the host only).
 */
const NAME = 'chains-api';
const tracer = () => trace.getTracer(NAME);

let provider = null;

export const tracingOn = () => provider !== null;

/** Register the tracer provider. `exporter` is injected by tests; production exports OTLP/HTTP protobuf. */
export async function startTelemetry({ enabled = false, serviceName = NAME, sampleRatio = 1, version = 'unknown' } = {}, { exporter = null, logger = console } = {}) {
  if (!enabled && !exporter) return { enabled: false, shutdown: async () => {} };
  if (provider) await stopTelemetry();
  let processor;
  if (exporter) {
    processor = new SimpleSpanProcessor({ exporter });
  } else {
    // Loaded only when tracing is on. Endpoint, headers and timeout come from the standard
    // OTEL_EXPORTER_OTLP_* variables, which the exporter reads itself.
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    processor = new BatchSpanProcessor({ exporter: new OTLPTraceExporter() });
  }
  provider = new TracerProvider({
    resource: defaultResource().merge(resourceFromAttributes({ 'service.name': serviceName, 'service.version': version })),
    // A request that arrives sampled stays sampled; a trace that starts here is kept at the ratio.
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) }),
    spanProcessors: [processor]
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  logger.info?.({ serviceName, sampleRatio }, 'OpenTelemetry tracing on');
  return { enabled: true, shutdown: stopTelemetry };
}

/** Flush what is buffered and unregister. Safe to call when tracing never started. */
export async function stopTelemetry() {
  const current = provider;
  provider = null;
  if (!current) return;
  await current.shutdown().catch(() => {});
  trace.disable();
  context.disable();
  propagation.disable();
}

const activeSpan = () => trace.getSpan(context.active());

/** Whether this code runs inside a recorded span: what a per-call span needs to be worth making. */
function inTrace() {
  return provider !== null && Boolean(activeSpan()?.isRecording());
}

/** Attributes without the null and undefined ones, which a span may not carry. */
export function clean(attributes) {
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([, value]) => value !== null && value !== undefined));
}

export function setAttributes(span, attributes) {
  span?.setAttributes(clean(attributes));
}

/** Attributes on the span this code runs in, if any. */
export function setActive(attributes) {
  setAttributes(activeSpan(), attributes);
}

/**
 * Mark a span failed by the error's category alone. Its message and stack are not recorded: an
 * endpoint's error text is the endpoint's own (rpcUtil.js builds errors from the response body)
 * and can echo a key or a request value.
 */
export function fail(span, err) {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute('error.type', label(err?.kind ?? err?.name, 'Error'));
}

// A short identifier, or the fallback: what a span name or attribute may be made of.
function label(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z][\w./-]{0,63}$/.test(value) ? value : fallback;
}

/**
 * Run `fn(span)` inside a span: ended when it settles, marked failed when it throws. The error
 * is rethrown untouched. With tracing off, `fn` runs directly.
 */
export function withSpan(name, { attributes = {}, kind = SpanKind.INTERNAL } = {}, fn) {
  if (!provider) return fn(null);
  return tracer().startActiveSpan(name, { kind, attributes: clean(attributes) }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * One span for a background job, and none for the calls inside it: `fn(span)` runs with tracing
 * suppressed, so a sweep over thousands of endpoints is one span carrying its totals.
 */
export function jobSpan(name, attributes, fn) {
  if (!provider) return fn(null);
  return withSpan(name, { attributes }, span => context.with(suppressTracing(context.active()), () => fn(span)));
}

/** `{trace_id, span_id}` of the span a log line is written in, for joining logs to traces. */
export function logIds() {
  const active = activeSpan()?.spanContext();
  return active && trace.isSpanContextValid(active) ? { trace_id: active.traceId, span_id: active.spanId } : {};
}

// A path segment that looks like a credential: long and without a word in it (an Infura or
// Alchemy key, a token, a hash). Route words ("chain-registry", "v2") stay.
const KEY_LIKE = /^(?=.*\d)[A-Za-z0-9_-]{20,}$|^[0-9a-fA-F]{16,}$/;
export function safePath(pathname) {
  return String(pathname ?? '').split('/').map(part => (KEY_LIKE.test(part) ? ':key' : part)).join('/');
}

// A service of ours in the cluster or on this host: where the trace context may go.
function internalHost(hostname) {
  if (/(^|\.)svc(\.cluster\.local)?$|^localhost$|^127\.|^\[?::1\]?$/.test(hostname)) return true;
  // A bare service name ("chains-client-feed"). An IPv6 literal has no dot either, and is not one.
  return !hostname.includes('.') && !hostname.includes(':');
}

/**
 * Record an outbound request as a client span, when it is made inside a traced request or job
 * (a call with no span around it is not traced: background polling would bury everything else).
 * The URL is recorded without its query string and with key-like path segments replaced. A call
 * to `/chat/completions` is named `chat <model>` and carries the GenAI attributes. The W3C
 * `traceparent` header is added only for services of ours in the cluster.
 */
export function tracedFetch(fetcher) {
  return async (input, init = {}) => {
    if (!provider || !activeSpan() || isTracingSuppressed(context.active())) return fetcher(input, init);
    let url = null;
    try {
      url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    } catch { /* recorded without a URL */ }
    // Part of a trace that is not sampled: no span, but a service of ours still gets the
    // caller's trace id and its decision, or it would start an unrelated trace of its own.
    if (!activeSpan().isRecording()) return fetcher(input, url && internalHost(url.hostname) ? withTraceContext(init) : init);
    const method = String(init?.method ?? 'GET').toUpperCase();
    const asked = url?.pathname.endsWith('/chat/completions') ? chatRequest(init?.body) : null;
    return withSpan(asked ? `chat ${asked.model}` : method, {
      kind: SpanKind.CLIENT,
      attributes: {
        ...(asked ? { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': asked.model, 'gen_ai.request.max_tokens': asked.maxTokens } : {}),
        'http.request.method': method,
        'url.full': url ? `${url.origin}${safePath(url.pathname)}` : null,
        'server.address': url?.hostname ?? null
      }
    }, async (span) => {
      const response = await fetcher(input, url && internalHost(url.hostname) ? withTraceContext(init) : init);
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      if (asked && response.ok) setAttributes(span, await chatAnswer(response));
      return response;
    });
  };
}

function withTraceContext(init) {
  const headers = { ...(init?.headers ?? {}) };
  propagation.inject(context.active(), headers);
  return { ...init, headers };
}

function chatRequest(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.model === 'string' ? { model: label(parsed.model, 'model'), maxTokens: Number.isFinite(parsed.max_tokens) ? parsed.max_tokens : null } : null;
  } catch {
    return null;
  }
}

// Read from a copy, so the caller still reads the answer itself.
async function chatAnswer(response) {
  try {
    const body = await response.clone().json();
    const finish = body?.choices?.[0]?.finish_reason;
    return {
      'gen_ai.response.model': body?.model,
      'gen_ai.response.finish_reasons': finish ? [finish] : null,
      'gen_ai.usage.input_tokens': body?.usage?.prompt_tokens,
      'gen_ai.usage.output_tokens': body?.usage?.completion_tokens
    };
  } catch {
    return {};
  }
}

/**
 * One JSON-RPC call as a client span (`rpc eth_blockNumber`), inside a traced request only. The
 * endpoint is recorded by host: its path may be an API key. The HTTP request underneath is not
 * recorded a second time.
 */
export function rpcSpan(url, method, fn) {
  if (!inTrace()) return fn();
  let host = null;
  try { host = new URL(url).hostname; } catch { /* recorded without a host */ }
  const name = label(method, 'other');
  return withSpan(`rpc ${name}`, {
    kind: SpanKind.CLIENT,
    attributes: { 'rpc.system': 'jsonrpc', 'rpc.method': name, 'server.address': host }
  }, () => context.with(suppressTracing(context.active()), fn));
}

/**
 * A database pool whose `query` is recorded as a client span inside a traced request, statement
 * text without values. Everything else on the pool is the pool's own.
 */
export function tracedPool(pool) {
  if (!pool || pool.traced) return pool;
  return new Proxy(pool, {
    get(target, key) {
      if (key === 'traced') return true;
      const value = Reflect.get(target, key, target);
      if (key !== 'query') return typeof value === 'function' ? value.bind(target) : value;
      return (sql, params) => {
        if (!inTrace()) return target.query(sql, params);
        const text = String(typeof sql === 'string' ? sql : sql?.sql ?? '').replace(/\s+/g, ' ').trim();
        return withSpan(`db ${text.split(' ')[0] ?? ''}`.trim(), {
          kind: SpanKind.CLIENT,
          attributes: { 'db.system.name': 'mariadb', 'db.query.summary': text.slice(0, 80) }
        }, () => target.query(sql, params));
      };
    }
  });
}

const PROBES = new Set(['/health', '/ready', '/metrics']);

/**
 * Fastify hooks: one server span per request, continuing the caller's trace when it sent a
 * `traceparent`. Probes and the metrics scrape are not traced.
 */
export function traceRequests(app, { skip = PROBES } = {}) {
  const spans = new WeakMap();
  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?')[0];
    if (!provider || skip.has(path)) return done();
    const parent = propagation.extract(context.active(), request.headers);
    const span = tracer().startSpan(request.method, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': request.method }
    }, parent);
    spans.set(request, span);
    // The rest of the request runs inside the span, so what the handler does nests under it.
    return context.with(trace.setSpan(parent, span), done);
  });
  app.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    if (span) {
      // The route template, never the raw path: bounded names, and no parameter values.
      const route = request.routeOptions?.url ?? null;
      if (route) {
        span.updateName(`${request.method} ${route}`);
        span.setAttribute('http.route', route);
      }
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
    done();
  });
}

// The JSON-RPC methods of the Model Context Protocol. A request names its method before it is
// authenticated, so anything else is recorded as `other`.
const MCP_METHODS = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list',
  'resources/subscribe', 'resources/unsubscribe', 'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel',
  'notifications/initialized', 'notifications/cancelled', 'notifications/progress', 'notifications/roots/list_changed'
]);

/**
 * Express middleware for the MCP endpoint: one server span per request to one of `paths` (a
 * trailing slash aside; any other path is not traced), named by its JSON-RPC method and tool
 * (`tools/call get_chain_by_id`). The method is recorded only when it is a protocol method and
 * the tool only when `tools()` lists it: both arrive unauthenticated, so anything else becomes
 * `other` / `unknown` and can neither grow a span nor multiply span names. Mount it after the
 * JSON body parser.
 */
export function traceMcp({ paths = ['/mcp'], tools = () => [] } = {}) {
  const known = new Set(paths);
  return (req, res, next) => {
    const route = String(req.path ?? '').replace(/(.)\/$/, '$1');
    if (!provider || !known.has(route)) return next();
    const parent = propagation.extract(context.active(), req.headers);
    const call = req.body && !Array.isArray(req.body) && typeof req.body.method === 'string' ? req.body : null;
    const method = call ? (MCP_METHODS.has(call.method) ? call.method : 'other') : null;
    const asked = method === 'tools/call' ? call.params?.name : null;
    const tool = method === 'tools/call' ? (typeof asked === 'string' && tools().includes(asked) ? asked : 'unknown') : null;
    const span = tracer().startSpan(method ? [method, tool].filter(Boolean).join(' ') : `${label(req.method, 'OTHER')} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: clean({
        'http.request.method': label(req.method, 'OTHER'),
        'http.route': route,
        'rpc.system': method ? 'jsonrpc' : null,
        'rpc.method': method,
        'mcp.tool.name': tool,
        'mcp.batch': Array.isArray(req.body) ? req.body.length : null
      })
    }, parent);
    res.once('close', () => {
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    });
    return context.with(trace.setSpan(parent, span), next);
  };
}

/**
 * Logger options with the trace ids added to every line: `false` stays off, `true` becomes the
 * mixin alone, and a caller's own options and mixin are kept.
 */
export function withLogIds(options) {
  if (options === false || options == null) return options;
  if (options === true) return { mixin: logIds };
  if (typeof options !== 'object' || typeof options.child === 'function') return options;
  const own = options.mixin;
  return { ...options, mixin: own ? (...args) => ({ ...own(...args), ...logIds() }) : logIds };
}

export { SpanKind };
