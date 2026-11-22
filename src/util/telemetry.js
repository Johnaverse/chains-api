import { trace, context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
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
let stopping = null;
// Spans started and not yet ended. Shutting the provider down sends finished spans only, so
// what is still running then (a request, an assistant run, a sweep) is ended first.
const live = new Set();
function begin(span) { live.add(span); return span; }
function finish(span) { live.delete(span); span.end(); }

export const tracingOn = () => provider !== null;

/** Register the tracer provider. `exporter` is injected by tests; production exports OTLP/HTTP protobuf. */
export async function startTelemetry({ enabled = false, serviceName = NAME, sampleRatio = 1, version = 'unknown' } = {}, { exporter = null, logger = console } = {}) {
  if (!enabled && !exporter) return { enabled: false, shutdown: async () => {} };
  if (stopping) await stopping;
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
export function stopTelemetry() {
  // A second call while the first is still sending (two signals in a row) waits for the same
  // flush instead of returning at once and letting the process exit under it.
  if (stopping) return stopping;
  const current = provider;
  provider = null;
  if (!current) return Promise.resolve();
  stopping = (async () => {
    for (const span of live) {
      span.setAttribute('shutdown', true);
      span.end();
    }
    live.clear();
    await current.shutdown().catch(() => {});
    trace.disable();
    context.disable();
    propagation.disable();
  })().finally(() => { stopping = null; });
  return stopping;
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

// A model as its provider writes it, tag and namespace included ("qwen3:latest",
// "pinax/qwen3.8-flash-next", "org/model@v2"), when it is a short name; else a fixed word.
function modelName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][\w.:/@+-]{0,95}$/.test(value) ? value : 'model';
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
    begin(span);
    try {
      return await fn(span);
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      finish(span);
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

// A URL path is recorded only where it reads as words. RPC and API URLs carry keys in their
// path, in any alphabet and sometimes percent-escaped, so a key cannot be recognised reliably;
// a plain route word can. Each segment is decoded and split on - _ . and is kept when every
// part is a short lowercase word, a short number, or a word with a number ("v2", "slip44").
// Anything else is recorded as `:key` ("DefiLlama" too: over-redaction is the safe side).
const PLAIN_PART = /^(?:[a-z]{1,14}|\d{1,6}|[a-z]{1,8}\d{1,6})$/;
function plainSegment(segment) {
  let text;
  try { text = decodeURIComponent(segment); } catch { return false; }
  return text.length <= 64 && text.split(/[-_.]/).every(part => PLAIN_PART.test(part));
}
export function safePath(pathname) {
  return String(pathname ?? '').split('/').map(part => (part === '' || plainSegment(part) ? part : ':key')).join('/');
}

// A service of ours in the cluster or on this host: where the trace context may go.
function internalHost(hostname) {
  // Cluster service names, and loopback as a whole address ("127.example.com" is a public name).
  if (/(^|\.)svc(\.cluster\.local)?$|^localhost$|^127(\.\d{1,3}){3}$|^\[?::1\]?$/.test(hostname)) return true;
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
    if (!activeSpan().isRecording()) return url && internalHost(url.hostname) ? sendWithTrace(fetcher, input, init) : fetcher(input, init);
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
      const response = await (url && internalHost(url.hostname) ? sendWithTrace(fetcher, input, init) : fetcher(input, init));
      span.setAttribute('http.response.status_code', response.status);
      if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      if (asked && response.ok) setAttributes(span, await chatAnswer(response));
      return response;
    });
  };
}

// The trace context goes to the host that was asked and no further: fetch would carry the header
// to wherever a redirect points, outside the cluster included. So the first hop is made without
// following, and a redirect is then followed here the way fetch follows one (the request is
// never sent a second time): to its Location, as a GET where the status says so, without the
// trace context, and without credentials when it leaves the origin.
async function sendWithTrace(fetcher, input, init) {
  if (init?.redirect && init.redirect !== 'follow') return fetcher(input, withTraceContext(init));
  const response = await fetcher(input, { ...withTraceContext(init), redirect: 'manual' });
  // The statuses that are redirects. A 304 is an answer, whatever headers it carries.
  const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers?.get?.('location') : null;
  if (!location) return response;
  let from;
  let to;
  try {
    from = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    to = new URL(location, from);
  } catch {
    return response;
  }
  await response.body?.cancel?.().catch(() => {});
  const method = String(init?.method ?? 'GET').toUpperCase();
  const asGet = response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST';
  const headers = new Headers(init?.headers ?? {});
  if (asGet) for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
  if (to.origin !== from.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
  const next = { ...init, headers };
  if (asGet) {
    next.method = 'GET';
    delete next.body;
  }
  return fetcher(to.href, next);
}

// The request with the trace context added to its headers, in whichever form the caller gave
// them: a plain object stays one; a Headers instance or a list of pairs becomes a Headers copy.
function withTraceContext(init) {
  const given = init?.headers;
  if (given && (typeof given.forEach === 'function' || Array.isArray(given))) {
    const headers = new Headers(given);
    propagation.inject(context.active(), headers, { set: (carrier, key, value) => carrier.set(key, value) });
    return { ...init, headers };
  }
  const headers = { ...(given ?? {}) };
  propagation.inject(context.active(), headers);
  return { ...init, headers };
}

/**
 * A span opened now and ended later by its holder, for work that has no single function around
 * it (a refresher sweep that advances tick by tick). It is not made the active span: what runs
 * during it is not traced under it. `end({abandoned})` may be called more than once.
 */
export function openSpan(name, attributes = {}) {
  if (!provider) return { set() {}, end() {} };
  let span = begin(tracer().startSpan(name, { kind: SpanKind.INTERNAL, attributes: clean(attributes), root: true }));
  return {
    set(more) { setAttributes(span, more); },
    end(more = {}) {
      if (!span) return;
      setAttributes(span, more);
      finish(span);
      span = null;
    }
  };
}

function chatRequest(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.model === 'string' ? { model: modelName(parsed.model), maxTokens: Number.isFinite(parsed.max_tokens) ? parsed.max_tokens : null } : null;
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
  if (!provider) return fn();
  const quiet = () => context.with(suppressTracing(context.active()), fn);
  // Not recorded (no trace around it, or one that is not sampled): still nothing of the trace
  // goes to the endpoint, whatever its host looks like.
  if (!inTrace()) return quiet();
  let host = null;
  try { host = new URL(url).hostname; } catch { /* recorded without a host */ }
  const name = label(method, 'other');
  return withSpan(`rpc ${name}`, {
    kind: SpanKind.CLIENT,
    attributes: { 'rpc.system': 'jsonrpc', 'rpc.method': name, 'server.address': host }
  }, quiet);
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
 * The context a request's span starts in. A `traceparent` is honoured only from a trusted
 * caller, a service of ours in the cluster: the header also carries the sampling decision, so
 * taking it from anyone would let a public client have every one of its requests recorded
 * whatever OTEL_TRACES_SAMPLER_ARG says, and choose our trace ids. Anyone else starts a new trace.
 */
function callerContext(headers, isTrusted) {
  return isTrusted ? propagation.extract(ROOT_CONTEXT, headers) : ROOT_CONTEXT;
}

/**
 * Fastify hooks: one server span per request. Probes and the metrics scrape are not traced.
 * `trusted(request)` says whether the caller is one of ours (see callerContext).
 */
export function traceRequests(app, { skip = PROBES, trusted = () => false } = {}) {
  const spans = new WeakMap();
  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?')[0];
    if (!provider || skip.has(path)) return done();
    const parent = callerContext(request.headers, trusted(request));
    const span = begin(tracer().startSpan(request.method, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': request.method }
    }, parent));
    spans.set(request, span);
    // Whatever becomes of the request, its span ends when the connection's response does: a
    // client that disconnects at a moment neither hook below covers must not leave it open.
    reply.raw?.once?.('close', () => {
      if (spans.get(request) !== span) return;
      spans.delete(request);
      span.setAttribute('http.request.aborted', true);
      finish(span);
    });
    // The rest of the request runs inside the span, so what the handler does nests under it.
    return context.with(trace.setSpan(parent, span), done);
  });
  // A client that goes away before the request is read gets no onResponse: end the span here.
  app.addHook('onRequestAbort', (request, done) => {
    const span = spans.get(request);
    if (span) {
      spans.delete(request);
      span.setAttribute('http.request.aborted', true);
      span.setStatus({ code: SpanStatusCode.ERROR });
      finish(span);
    }
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const span = spans.get(request);
    if (span) {
      spans.delete(request);
      // The route template, never the raw path: bounded names, and no parameter values.
      const route = request.routeOptions?.url ?? null;
      if (route) {
        span.updateName(`${request.method} ${route}`);
        span.setAttribute('http.route', route);
      }
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      finish(span);
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
export function traceMcp({ paths = ['/mcp'], tools = () => [], trusted = () => false } = {}) {
  const known = new Set(paths);
  return (req, res, next) => {
    const route = String(req.path ?? '').replace(/(.)\/$/, '$1');
    if (!provider || !known.has(route)) return next();
    const parent = callerContext(req.headers, trusted(req));
    const call = req.body && !Array.isArray(req.body) && typeof req.body.method === 'string' ? req.body : null;
    const method = call ? (MCP_METHODS.has(call.method) ? call.method : 'other') : null;
    const asked = method === 'tools/call' ? call.params?.name : null;
    const tool = method === 'tools/call' ? (typeof asked === 'string' && tools().includes(asked) ? asked : 'unknown') : null;
    const span = begin(tracer().startSpan(method ? [method, tool].filter(Boolean).join(' ') : `${label(req.method, 'OTHER')} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: clean({
        'http.request.method': label(req.method, 'OTHER'),
        'http.route': route,
        'rpc.system': method ? 'jsonrpc' : null,
        'rpc.method': method,
        'mcp.tool.name': tool,
        'mcp.batch': Array.isArray(req.body) ? req.body.length : null
      })
    }, parent));
    res.once('close', () => {
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      if (live.has(span)) finish(span);
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
