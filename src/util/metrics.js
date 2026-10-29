import v8 from 'node:v8';
/**
 * Lightweight, dependency-free Prometheus-format metrics.
 *
 * Tracks counters (monotonic) and gauges (point-in-time). Counters are
 * incremented from anywhere; gauges are computed on /metrics scrape from
 * the cache so they always reflect current state without an updater loop.
 *
 * Exposes a single render() function that emits Prometheus text exposition
 * format (https://prometheus.io/docs/instrumenting/exposition_formats/).
 */

const counters = new Map();
// name -> Map(labelKey -> { labels, buckets: number[], sum, count })
const histograms = new Map();
// Seconds. Covers a cached answer (milliseconds) to a slow profile assembly (8 s bound).
const HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Escape a string for use as a Prometheus label value. Per the exposition
 * format spec, label values must escape `\` (as `\\`), `"` (as `\"`), and
 * newlines (as `\n`). Order matters: backslash first, otherwise the literal
 * `\` inserted by the quote-escape would itself get re-escaped.
 */
function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function counterKey(name, labels) {
  const labelStr = Object.entries(labels || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return labelStr ? `${name}{${labelStr}}` : name;
}

export function incCounter(name, labels = {}, value = 1) {
  const key = counterKey(name, labels);
  counters.set(key, (counters.get(key) || 0) + value);
}

/** Record one observation (seconds) in a histogram with the shared buckets. */
export function observeHistogram(name, labels = {}, value) {
  if (!Number.isFinite(value)) return;
  if (!histograms.has(name)) histograms.set(name, new Map());
  const series = histograms.get(name);
  const key = counterKey('', labels);
  let h = series.get(key);
  if (!h) {
    h = { labels, buckets: HISTOGRAM_BUCKETS.map(() => 0), sum: 0, count: 0 };
    series.set(key, h);
  }
  HISTOGRAM_BUCKETS.forEach((le, i) => { if (value <= le) h.buckets[i] += 1; });
  h.sum += value;
  h.count += 1;
}

function formatHistograms(lines) {
  for (const [name, series] of histograms.entries()) {
    lines.push(`# HELP ${name} ${METRIC_HELP[name] || ''}`);
    lines.push(`# TYPE ${name} histogram`);
    for (const h of series.values()) {
      const withLe = (le) => counterKey(`${name}_bucket`, { ...h.labels, le });
      HISTOGRAM_BUCKETS.forEach((le, i) => lines.push(`${withLe(String(le))} ${h.buckets[i]}`));
      lines.push(`${withLe('+Inf')} ${h.count}`);
      lines.push(`${counterKey(`${name}_sum`, h.labels)} ${h.sum}`);
      lines.push(`${counterKey(`${name}_count`, h.labels)} ${h.count}`);
    }
  }
}

function formatCounters(lines) {
  // Group by metric name for proper HELP/TYPE headers.
  const byName = new Map();
  for (const [key, value] of counters.entries()) {
    const name = key.split('{')[0];
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push([key, value]);
  }
  for (const [name, entries] of byName.entries()) {
    lines.push(`# HELP ${name} ${METRIC_HELP[name] || ''}`);
    lines.push(`# TYPE ${name} counter`);
    for (const [key, value] of entries) {
      lines.push(`${key} ${value}`);
    }
  }
}

const METRIC_HELP = {
  chains_api_source_fetch_total: 'Number of source fetch attempts by source and outcome',
  chains_api_refresh_total: 'Number of background refresh runs by refresher and outcome',
  chains_api_rpc_check_total: 'Number of RPC endpoint health checks by outcome',
  chains_api_rpc_private_dropped_total: 'Number of RPC endpoints dropped as non-public (HTTP 401/403)',
  chains_api_assistant_requests_total: 'Number of assistant chat requests by outcome (ok, degraded)',
  chains_api_assistant_tool_calls_total: 'Number of assistant tool executions by tool and outcome',
  chains_api_assistant_llm_calls_total: 'Number of LLM round-trips made by the assistant by outcome',
  chains_api_assistant_reply_sanitized_total: 'Number of assistant replies altered by the sanitizer, by kind (leak, whole_repeat)',
  chains_api_http_requests_total: 'API requests by route template, method, status class and client kind (internal, dashboard, browser, bot, script)',
  chains_api_http_request_duration_seconds: 'API request duration in seconds by route template and method',
  chains_api_mcp_rpc_total: 'MCP JSON-RPC requests by method and HTTP status class',
  chains_api_mcp_tool_calls_total: 'MCP tool calls by tool and HTTP status class'
};

/**
 * Emit Prometheus exposition format. Gauges are computed on the fly from
 * the live cache to avoid drift.
 */
export function renderMetrics({ cache, rpcStatus, l2beatStatus, validationSummary, incidentSummary, clientFeedCache }) {
  const lines = [];

  formatCounters(lines);
  formatHistograms(lines);

  // Process memory: growth toward the heap limit shows here before the process dies of it
  // (2026-10-24: "JavaScript heap out of memory" after 18.5 h, with nothing on /metrics to see).
  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  lines.push('# HELP chains_api_process_resident_bytes Resident memory of the process');
  lines.push('# TYPE chains_api_process_resident_bytes gauge');
  lines.push(`chains_api_process_resident_bytes ${mem.rss}`);
  lines.push('# HELP chains_api_heap_used_bytes JavaScript heap in use');
  lines.push('# TYPE chains_api_heap_used_bytes gauge');
  lines.push(`chains_api_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP chains_api_heap_limit_bytes JavaScript heap size limit');
  lines.push('# TYPE chains_api_heap_limit_bytes gauge');
  lines.push(`chains_api_heap_limit_bytes ${heapLimit}`);
  if (clientFeedCache) {
    lines.push('# HELP chains_api_client_feed_cache_bytes Client-feed responses held in memory');
    lines.push('# TYPE chains_api_client_feed_cache_bytes gauge');
    lines.push(`chains_api_client_feed_cache_bytes ${clientFeedCache.bytes}`);
    lines.push('# HELP chains_api_client_feed_cache_entries Client-feed responses cached');
    lines.push('# TYPE chains_api_client_feed_cache_entries gauge');
    lines.push(`chains_api_client_feed_cache_entries ${clientFeedCache.entries}`);
  }

  // Gauges
  lines.push('# HELP chains_api_chains_total Total chains in the index');
  lines.push('# TYPE chains_api_chains_total gauge');
  lines.push(`chains_api_chains_total ${cache?.indexed?.all?.length ?? 0}`);

  lines.push('# HELP chains_api_source_loaded Source loaded status (1=loaded, 0=not)');
  lines.push('# TYPE chains_api_source_loaded gauge');
  lines.push(`chains_api_source_loaded{source="theGraph"} ${cache?.theGraph != null ? 1 : 0}`);
  lines.push(`chains_api_source_loaded{source="chainlist"} ${cache?.chainlist != null ? 1 : 0}`);
  lines.push(`chains_api_source_loaded{source="chains"} ${cache?.chains != null ? 1 : 0}`);
  lines.push(`chains_api_source_loaded{source="slip44"} ${cache?.slip44 != null ? 1 : 0}`);
  lines.push(`chains_api_source_loaded{source="l2beat"} ${cache?.l2beat?.projects?.length > 0 ? 1 : 0}`);

  if (cache?.lastUpdated) {
    const age = Math.max(0, Math.round((Date.now() - new Date(cache.lastUpdated).getTime()) / 1000));
    lines.push('# HELP chains_api_data_age_seconds Age of indexed data in seconds');
    lines.push('# TYPE chains_api_data_age_seconds gauge');
    lines.push(`chains_api_data_age_seconds ${age}`);
  }

  if (l2beatStatus?.lastRefreshAt) {
    const age = Math.max(0, Math.round((Date.now() - new Date(l2beatStatus.lastRefreshAt).getTime()) / 1000));
    lines.push('# HELP chains_api_l2beat_refresh_age_seconds Seconds since the last L2BEAT refresh');
    lines.push('# TYPE chains_api_l2beat_refresh_age_seconds gauge');
    lines.push(`chains_api_l2beat_refresh_age_seconds ${age}`);
  }

  if (rpcStatus?.lastUpdated) {
    const age = Math.max(0, Math.round((Date.now() - new Date(rpcStatus.lastUpdated).getTime()) / 1000));
    lines.push('# HELP chains_api_rpc_check_age_seconds Seconds since the last RPC health sweep');
    lines.push('# TYPE chains_api_rpc_check_age_seconds gauge');
    lines.push(`chains_api_rpc_check_age_seconds ${age}`);
  }

  if (validationSummary) {
    lines.push('# HELP chains_api_validation_errors Total validation errors by rule number');
    lines.push('# TYPE chains_api_validation_errors gauge');
    for (const [ruleKey, count] of Object.entries(validationSummary)) {
      lines.push(`chains_api_validation_errors{rule="${escapeLabelValue(ruleKey)}"} ${count}`);
    }
  }

  // "observations", not "contradictions": the series carries A1, which the sentinel defines as
  // a grounding measurement and deliberately keeps out of its own findings total. Labelling it
  // a contradiction would have a healthy feed that attributes chains well look broken — and
  // would be the exact kind of internal disagreement this sentinel exists to report.
  if (incidentSummary) {
    lines.push('# HELP chains_api_incident_sentinel_observations Incident-feed sentinel results by rule; S rules are contradictions, A rules are grounding measurements');
    lines.push('# TYPE chains_api_incident_sentinel_observations gauge');
    for (const [ruleKey, count] of Object.entries(incidentSummary)) {
      lines.push(`chains_api_incident_sentinel_observations{rule="${escapeLabelValue(ruleKey)}"} ${count}`);
    }
  }

  return lines.join('\n') + '\n';
}

// Test-only helper.
export function _resetMetricsForTests() {
  counters.clear();
  histograms.clear();
}
