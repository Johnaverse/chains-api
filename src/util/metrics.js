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
  chains_api_rpc_private_dropped_total: 'Number of RPC endpoints dropped as private (HTTP 401)',
  chains_api_assistant_requests_total: 'Number of assistant chat requests by outcome (ok, degraded)',
  chains_api_assistant_tool_calls_total: 'Number of assistant tool executions by tool and outcome',
  chains_api_assistant_llm_calls_total: 'Number of LLM round-trips made by the assistant by outcome',
  chains_api_assistant_reply_sanitized_total: 'Number of assistant replies altered by the sanitizer, by kind (leak, whole_repeat)'
};

/**
 * Emit Prometheus exposition format. Gauges are computed on the fly from
 * the live cache to avoid drift.
 */
export function renderMetrics({ cache, rpcStatus, l2beatStatus, validationSummary }) {
  const lines = [];

  formatCounters(lines);

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

  return lines.join('\n') + '\n';
}

// Test-only helper.
export function _resetMetricsForTests() {
  counters.clear();
}
