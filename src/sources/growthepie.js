import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GROWTHEPIE_ENABLED,
  GROWTHEPIE_API_URL,
  GROWTHEPIE_FETCH_TIMEOUT_MS,
  GROWTHEPIE_REFRESH_TICK_MS
} from '../../config.js';
import { getFeed } from './feedHttp.js';
import { logger } from '../util/logger.js';

/**
 * growthepie (https://www.growthepie.com): Ethereum L2 fundamentals, fees, economics, blockspace
 * and data-availability usage, joined to the registry by EVM chain ID.
 *
 * Chain-level data is growthepie's public "Basic" tier; their usage rules require growthepie to be
 * named as the source wherever it is shown, so every answer carries ATTRIBUTION. Their API is
 * public today but they reserve the right to gate it: each file falls back to the checked-in
 * snapshot (data/growthepie-fallback.json, scripts/update-growthepie-fallback.mjs) when it has
 * never been read live.
 *
 * Each file has its own cadence (growthepie rebuilds fundamentals and fees hourly, the rest less
 * often). Reads never wait on a refresh once anything is loaded: a due file is re-read in the
 * background and the previous answer is served meanwhile.
 */

export const ATTRIBUTION = Object.freeze({
  source: 'growthepie',
  url: 'https://www.growthepie.com',
  note: 'Data: growthepie (chain-level, Basic tier). Attribute growthepie when reusing it.'
});

const HOUR = 60 * 60 * 1000;
// name -> path under GROWTHEPIE_API_URL and how old a copy may get before it is re-read.
export const FILES = Object.freeze({
  master: { path: 'master.json', maxAgeMs: 24 * HOUR },
  fundamentals: { path: 'fundamentals.json', maxAgeMs: HOUR },
  fees: { path: 'fees/table.json', maxAgeMs: HOUR },
  landing: { path: 'landing_page.json', maxAgeMs: HOUR },
  economics: { path: 'economics.json', maxAgeMs: 6 * HOUR },
  blockspace: { path: 'blockspace/overview.json', maxAgeMs: 6 * HOUR },
  da: { path: 'da_overview.json', maxAgeMs: 6 * HOUR },
  ethSupply: { path: 'eim/eth_supply.json', maxAgeMs: 24 * HOUR }
});

const SPANS = ['1d', '7d', '30d', '90d', '180d', '365d', 'max'];
// Days of daily history kept per metric (fundamentals.json carries ~90).
const SERIES_DAYS = 90;
const SUPPLY_SERIES_DAYS = 365;

const __dir = dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = join(__dir, '..', '..', 'data', 'growthepie-fallback.json');

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/** A `{types:[...], data|total:[...]}` row as an object keyed by type. */
function zip(types, row) {
  if (!Array.isArray(types) || !Array.isArray(row)) return null;
  const out = {};
  types.forEach((t, i) => { out[t] = row[i]; });
  return out;
}

// ─── normalizers (pure; exported for tests and the fallback script) ─────────

/** master.json: chain metadata keyed by growthepie origin key, plus metric and category labels. */
export function normalizeMaster(json) {
  const chains = {};
  for (const [originKey, c] of Object.entries(isObj(json?.chains) ? json.chains : {})) {
    if (!isObj(c)) continue;
    const chainId = Number.isSafeInteger(c.evm_chain_id) ? c.evm_chain_id : null;
    const stage = isObj(c.l2beat_stage) ? str(c.l2beat_stage.stage) : str(c.l2beat_stage);
    chains[originKey] = {
      originKey,
      chainId,
      name: str(c.name),
      nameShort: str(c.name_short),
      urlKey: str(c.url_key),
      url: str(c.url_key) ? `https://www.growthepie.com/chains/${c.url_key}` : null,
      chainType: str(c.chain_type),
      caip2: str(c.caip2),
      deployment: str(c.deployment),
      company: str(c.company),
      description: str(c.description),
      symbol: str(c.symbol),
      gasToken: str(c.gas_token),
      bucket: str(c.bucket),
      ecosystem: Array.isArray(c.ecosystem) ? c.ecosystem.filter(e => typeof e === 'string') : [],
      technology: str(c.technology),
      purpose: str(c.purpose),
      launchDate: str(c.launch_date),
      stack: isObj(c.stack) ? { label: str(c.stack.label), url: str(c.stack.url) } : (str(c.stack) ? { label: str(c.stack), url: null } : null),
      daLayer: str(c.da_layer),
      raas: str(c.raas),
      maturity: str(c.maturity),
      l2beat: { stage, id: str(c.l2beat_id), url: str(c.l2beat_link) },
      website: str(c.website),
      twitter: str(c.twitter),
      explorers: isObj(c.block_explorers) ? Object.entries(c.block_explorers).map(([name, url]) => ({ name, url: str(url) })).filter(e => e.url) : (str(c.block_explorer) ? [{ name: null, url: str(c.block_explorer) }] : []),
      supportedMetrics: Array.isArray(c.supported_metrics) ? c.supported_metrics.filter(m => typeof m === 'string') : []
    };
  }
  const metrics = {};
  for (const [key, m] of Object.entries(isObj(json?.metrics) ? json.metrics : {})) {
    if (!isObj(m)) continue;
    metrics[key] = {
      name: str(m.name),
      category: str(m.category),
      metricKeys: Array.isArray(m.metric_keys) ? m.metric_keys.filter(k => typeof k === 'string') : [],
      aggregate: str(m.all_l2s_aggregate),
      url: str(m.url_path) ? `https://www.growthepie.com${m.url_path}` : null
    };
  }
  const categories = isObj(json?.blockspace_categories?.main_categories) ? { ...json.blockspace_categories.main_categories } : {};
  return { chains, metrics, categories, lastUpdatedUtc: str(json?.last_updated_utc) };
}

/** fundamentals.json rows -> originKey -> metricKey -> [[date, value]] ascending, last SERIES_DAYS days. */
export function normalizeFundamentals(rows, { days = SERIES_DAYS } = {}) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const origin = str(r?.origin_key);
    const metric = str(r?.metric_key);
    const date = str(r?.date);
    const value = num(r?.value);
    if (!origin || !metric || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || value == null) continue;
    ((out[origin] ??= {})[metric] ??= []).push([date, value]);
  }
  for (const metrics of Object.values(out)) {
    for (const [key, series] of Object.entries(metrics)) {
      series.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      // One value per day: the last one wins.
      const byDay = new Map(series.map(p => [p[0], p[1]]));
      metrics[key] = [...byDay.entries()].slice(-days);
    }
  }
  return out;
}

/** fees/table.json: the newest hourly reading of each fee/throughput metric per chain. */
export function normalizeFees(json) {
  const out = {};
  for (const [origin, c] of Object.entries(isObj(json?.chain_data) ? json.chain_data : {})) {
    const hourly = c?.hourly;
    if (!isObj(hourly)) continue;
    const metrics = {};
    for (const [metric, block] of Object.entries(hourly)) {
      const rows = Array.isArray(block?.data) ? block.data : [];
      let newest = null;
      for (const row of rows) {
        const z = zip(block.types, row);
        if (z && num(z.unix) != null && (!newest || z.unix > newest.unix)) newest = z;
      }
      if (!newest) continue;
      metrics[metric] = {
        at: new Date(newest.unix).toISOString(),
        ...(num(newest.value_usd) != null ? { usd: num(newest.value_usd) } : {}),
        ...(num(newest.value_eth) != null ? { eth: num(newest.value_eth) } : {}),
        ...(num(newest.value) != null ? { value: num(newest.value) } : {})
      };
    }
    if (Object.keys(metrics).length) out[origin] = metrics;
  }
  return out;
}

// landing_page.json aggregate metric -> the fundamentals.json key it matches (USD where priced).
const LANDING_METRIC_KEYS = { txcount: 'txcount', stables_mcap: 'stables_mcap', rent_paid: 'rent_paid_usd', market_cap: 'market_cap_usd', fees: 'fees_paid_usd', throughput: 'throughput' };

/**
 * landing_page.json: per chain, users, user share, cross-chain activity and rank per metric; and
 * the daily series of the all-L2 aggregate (and Ethereum), which fundamentals.json does not carry.
 */
export function normalizeLanding(json, { days = SERIES_DAYS } = {}) {
  const chains = {};
  for (const [origin, c] of Object.entries(isObj(json?.data?.metrics?.table_visual) ? json.data.metrics.table_visual : {})) {
    if (!isObj(c)) continue;
    const ranking = {};
    for (const [metric, r] of Object.entries(isObj(c.ranking) ? c.ranking : {})) {
      if (num(r?.rank) != null) ranking[metric] = { rank: num(r.rank), outOf: num(r.out_of) };
    }
    chains[origin] = {
      users: num(c.users),
      userShare: num(c.user_share),
      crossChainActivity: num(c.cross_chain_activity),
      ranking
    };
  }
  const aggregates = {};
  for (const origin of ['all_l2s', 'ethereum']) {
    const metrics = json?.data?.[origin]?.metrics;
    if (!isObj(metrics)) continue;
    const out = {};
    for (const [metric, block] of Object.entries(metrics)) {
      const daily = block?.daily;
      const series = (Array.isArray(daily?.data) ? daily.data : [])
        .map(row => zip(daily.types, row))
        .filter(z => z && num(z.unix) != null && (num(z.usd) ?? num(z.value)) != null)
        .sort((a, b) => a.unix - b.unix)
        .map(z => [dayOf(z.unix), num(z.usd) ?? num(z.value)]);
      if (series.length) out[LANDING_METRIC_KEYS[metric] ?? metric] = series.slice(-days);
    }
    if (Object.keys(out).length) aggregates[origin] = out;
  }
  return { chains, aggregates };
}

function economicsSpan(s) {
  if (!isObj(s)) return null;
  const pair = (block, field) => zip(block?.types, block?.[field]) ?? {};
  const revenue = pair(s.revenue, 'total');
  const costs = pair(s.costs, 'total');
  const costsL1 = pair(s.costs, 'costs_l1');
  const costsBlobs = pair(s.costs, 'costs_blobs');
  const profit = pair(s.profit, 'total');
  const margin = pair(s.profit_margin, 'total');
  const size = pair(s.size, 'total');
  return {
    revenueUsd: num(revenue.usd), revenueEth: num(revenue.eth),
    costsUsd: num(costs.usd), costsEth: num(costs.eth),
    costsL1Usd: num(costsL1.usd), costsBlobsUsd: num(costsBlobs.usd),
    profitUsd: num(profit.usd), profitEth: num(profit.eth),
    profitMargin: num(margin.percentage),
    dataPostedBytes: num(size.bytes)
  };
}

/** economics.json: revenue (fees paid by users), L1/blob costs and profit per chain per span. */
export function normalizeEconomics(json) {
  const out = {};
  for (const [origin, spans] of Object.entries(isObj(json?.data?.chain_breakdown) ? json.data.chain_breakdown : {})) {
    const chain = {};
    for (const span of SPANS) {
      const e = economicsSpan(spans?.[span]);
      if (e) chain[span] = e;
    }
    if (Object.keys(chain).length) out[origin] = chain;
  }
  return out;
}

/** blockspace/overview.json: gas fees and transactions by category (finance, social, …) per span. */
export function normalizeBlockspace(json) {
  const out = {};
  for (const [origin, c] of Object.entries(isObj(json?.data?.chains) ? json.data.chains : {})) {
    const types = c?.overview?.types;
    if (!Array.isArray(types)) continue;
    const chain = {};
    for (const span of SPANS) {
      const block = c.overview[span];
      if (!isObj(block)) continue;
      const categories = {};
      for (const [cat, v] of Object.entries(block)) {
        const z = zip(types, v?.data);
        if (!z) continue;
        categories[cat] = {
          gasFeesUsd: num(z.gas_fees_usd_absolute),
          gasFeesEth: num(z.gas_fees_eth_absolute),
          txcount: num(z.txcount_absolute),
          gasFeesShareUsd: num(z.gas_fees_share_usd),
          txcountShare: num(z.txcount_share)
        };
      }
      if (Object.keys(categories).length) chain[span] = categories;
    }
    if (Object.keys(chain).length) out[origin] = chain;
  }
  return out;
}

/** da_overview.json: per DA layer, fees, data posted and its consumers per span; top consumers. */
export function normalizeDa(json) {
  const layers = {};
  for (const [daId, spans] of Object.entries(isObj(json?.data?.da_breakdown) ? json.data.da_breakdown : {})) {
    if (daId === 'totals') continue;
    const layer = {};
    for (const span of SPANS) {
      const s = spans?.[span];
      if (!isObj(s)) continue;
      const fees = zip(s.fees?.types, s.fees?.total) ?? {};
      const size = zip(s.size?.types, s.size?.total) ?? {};
      const perMb = zip(s.fees_per_mb?.types, s.fees_per_mb?.total) ?? {};
      const consumers = (Array.isArray(s.da_consumers?.chains?.values) ? s.da_consumers.chains.values : [])
        .map(v => zip(s.da_consumers.chains.types, v))
        .filter(Boolean)
        .map(z => ({ key: str(z.da_consumer_key), name: str(z.name), originKey: str(z.gtp_origin_key) }));
      layer[span] = {
        feesUsd: num(fees.usd), feesEth: num(fees.eth),
        dataPostedBytes: num(size.bytes),
        feesPerMbUsd: num(perMb.usd),
        consumerCount: num(s.da_consumers?.count) ?? consumers.length,
        consumers
      };
    }
    if (Object.keys(layer).length) layers[daId] = layer;
  }
  const topConsumers = {};
  for (const span of SPANS) {
    const t = json?.data?.all_da?.top_da_consumers?.[span];
    if (!Array.isArray(t?.data)) continue;
    topConsumers[span] = t.data.map(row => zip(t.types, row)).filter(Boolean).map(z => ({
      key: str(z.da_consumer_key), name: str(z.name), daLayer: str(z.da_layer), originKey: str(z.origin_key), dataPostedBytes: num(z.data_posted)
    }));
  }
  return { layers, topConsumers, lastUpdatedUtc: str(json?.last_updated_utc) };
}

/** eim/eth_supply.json: ETH supply and issuance rate (latest + last year daily) and supply events. */
export function normalizeEthSupply(json, { days = SUPPLY_SERIES_DAYS } = {}) {
  const series = block => (Array.isArray(block?.data) ? block.data : [])
    .map(row => zip(block.types, row))
    .filter(z => z && num(z.unix) != null && num(z.value) != null)
    .sort((a, b) => a.unix - b.unix)
    .map(z => [dayOf(z.unix), num(z.value)]);
  const supply = series(json?.data?.chart?.eth_supply?.daily);
  const issuance = series(json?.data?.chart?.eth_issuance_rate?.daily);
  const latest = s => (s.length ? { date: s.at(-1)[0], value: s.at(-1)[1] } : null);
  return {
    supply: latest(supply),
    issuanceRate: latest(issuance),
    supplySeries: supply.slice(-days),
    issuanceSeries: issuance.slice(-days),
    events: (Array.isArray(json?.data?.events) ? json.data.events : []).map(e => ({
      date: str(e?.date), type: str(e?.type), title: str(e?.title), issuance: str(e?.issuance), description: str(e?.description), source: str(e?.source)
    })).filter(e => e.date && e.title),
    lastUpdatedUtc: str(json?.last_updated_utc)
  };
}

const NORMALIZE = {
  master: normalizeMaster,
  fundamentals: rows => normalizeFundamentals(rows),
  fees: normalizeFees,
  landing: json => normalizeLanding(json),
  economics: normalizeEconomics,
  blockspace: normalizeBlockspace,
  da: normalizeDa,
  ethSupply: json => normalizeEthSupply(json)
};

// A part that normalizes to nothing means the upstream shape drifted: keep the last good copy.
const isEmpty = (name, part) => {
  if (part == null) return true;
  if (name === 'master') return Object.keys(part.chains).length === 0;
  if (name === 'da') return Object.keys(part.layers).length === 0;
  if (name === 'ethSupply') return part.supply == null;
  if (name === 'landing') return Object.keys(part.chains ?? {}).length === 0;
  return Object.keys(part).length === 0;
};

// ─── state ──────────────────────────────────────────────────────────────────

const state = {
  // name -> { data, fetchedAt (ms), source: 'live'|'fallback', error, lastAttemptAt }
  parts: {},
  refreshing: null,
  timer: null,
  fallbackLoaded: false
};

function loadFallback() {
  if (state.fallbackLoaded) return;
  state.fallbackLoaded = true;
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(FALLBACK_PATH, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message }, 'growthepie fallback snapshot unavailable');
    return;
  }
  const fetchedAt = Date.parse(snapshot?.fetchedAt ?? '') || 0;
  for (const name of Object.keys(FILES)) {
    const data = snapshot?.parts?.[name];
    if (data != null && !state.parts[name]?.data) state.parts[name] = { data, fetchedAt, source: 'fallback', error: null, lastAttemptAt: null };
  }
}

async function fetchPart(name) {
  const { path } = FILES[name];
  const entry = state.parts[name] ?? (state.parts[name] = { data: null, fetchedAt: 0, source: null, error: null, lastAttemptAt: null });
  entry.lastAttemptAt = Date.now();
  try {
    const res = await getFeed(`${GROWTHEPIE_API_URL.replace(/\/+$/, '')}/${path}`, GROWTHEPIE_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = NORMALIZE[name](await res.json());
    if (isEmpty(name, data)) throw new Error('no usable data (upstream shape changed?)');
    Object.assign(entry, { data, fetchedAt: Date.now(), source: 'live', error: null });
  } catch (err) {
    entry.error = String(err?.message ?? err).slice(0, 200);
    logger.warn({ file: path, err: entry.error }, 'growthepie fetch failed; keeping the previous copy');
  }
}

const isDue = (name, now) => {
  const e = state.parts[name];
  if (!e?.data || e.source !== 'live') {
    // Not live yet: retry, but not more than every 10 minutes after a failure.
    return !e?.lastAttemptAt || now - e.lastAttemptAt > 10 * 60 * 1000;
  }
  return now - e.fetchedAt > FILES[name].maxAgeMs;
};

/** Re-read every due file (concurrently). Resolves when done; never throws. */
export function refreshGrowthepie({ force = false } = {}) {
  if (!GROWTHEPIE_ENABLED) return Promise.resolve();
  if (state.refreshing) return state.refreshing;
  loadFallback();
  const now = Date.now();
  const due = Object.keys(FILES).filter(name => force || isDue(name, now));
  if (!due.length) return Promise.resolve();
  state.refreshing = Promise.allSettled(due.map(fetchPart)).finally(() => { state.refreshing = null; });
  return state.refreshing;
}

/**
 * Make sure something is loaded. The first call waits for the live read (or the snapshot); later
 * calls start a background refresh of due files and return at once.
 */
export async function ensureGrowthepie() {
  if (!GROWTHEPIE_ENABLED) return;
  loadFallback();
  const loaded = Object.values(state.parts).some(p => p?.data && p.source === 'live');
  if (!loaded && Object.keys(FILES).some(name => isDue(name, Date.now()))) {
    await refreshGrowthepie();
    return;
  }
  refreshGrowthepie().catch(() => {});
}

export function startGrowthepieRefresh() {
  if (!GROWTHEPIE_ENABLED || state.timer) return;
  refreshGrowthepie().catch(() => {});
  state.timer = setInterval(() => refreshGrowthepie().catch(() => {}), GROWTHEPIE_REFRESH_TICK_MS);
  state.timer.unref?.();
}

export function stopGrowthepieRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

export function getGrowthepieStatus() {
  const files = {};
  for (const name of Object.keys(FILES)) {
    const e = state.parts[name];
    files[name] = {
      path: FILES[name].path,
      source: e?.source ?? null,
      fetchedAt: e?.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
      error: e?.error ?? null
    };
  }
  return { enabled: GROWTHEPIE_ENABLED, apiUrl: GROWTHEPIE_API_URL, refreshing: Boolean(state.refreshing), files };
}

// ─── assembly ───────────────────────────────────────────────────────────────

const part = name => state.parts[name]?.data ?? null;

/** The value `days` before the latest point in a [[date, value]] series, by calendar date. */
function valueDaysBefore(series, days) {
  if (!series?.length) return null;
  const target = new Date(Date.parse(`${series.at(-1)[0]}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  for (let i = series.length - 1; i >= 0; i--) if (series[i][0] <= target) return series[i][0] === target ? series[i][1] : null;
  return null;
}
const change = (now, before) => (now != null && before != null && before !== 0 ? now / before - 1 : null);

// Mean of the values in the `days` days ending `offset` days before the latest date; null unless
// every one of those days is present (a gap would bias it).
function windowMean(series, days, offset = 0) {
  const end = Date.parse(`${series.at(-1)[0]}T00:00:00Z`) - offset * 86400000;
  const start = end - (days - 1) * 86400000;
  const values = series.filter(([d]) => { const t = Date.parse(`${d}T00:00:00Z`); return t >= start && t <= end; }).map(p => p[1]);
  return values.length === days ? values.reduce((a, b) => a + b, 0) / days : null;
}

/**
 * Latest value, single-day changes (that day vs 7 / 30 days before: spiky on event days), and the
 * 7-day average with its week-over-week change, which is the steadier trend.
 */
function metricSummary(series) {
  const latest = series.at(-1);
  const avg7d = windowMean(series, 7);
  return {
    date: latest[0],
    value: latest[1],
    change7d: change(latest[1], valueDaysBefore(series, 7)),
    change30d: change(latest[1], valueDaysBefore(series, 30)),
    avg7d,
    avg7dChange: change(avg7d, windowMean(series, 7, 7))
  };
}

function origins() {
  const master = part('master');
  const keys = new Set([
    ...Object.keys(master?.chains ?? {}),
    ...Object.keys(part('fundamentals') ?? {}),
    ...Object.keys(part('landing')?.aggregates ?? {})
  ]);
  return [...keys];
}

function chainIdOf(originKey) {
  return part('master')?.chains?.[originKey]?.chainId ?? null;
}

function daUseOf(originKey) {
  const out = [];
  for (const [daId, spans] of Object.entries(part('da')?.layers ?? {})) {
    if (spans['30d']?.consumers?.some(c => c.originKey === originKey)) out.push(daId);
  }
  return out;
}

/**
 * Everything growthepie publishes about one origin.
 * @param {object} options  series: include the daily history per metric
 */
function assemble(originKey, { series = false } = {}) {
  const meta = part('master')?.chains?.[originKey] ?? null;
  // fundamentals.json first; the landing page's series fill what it lacks (the all-L2 aggregate).
  const fundamentals = { ...(part('landing')?.aggregates?.[originKey] ?? {}), ...(part('fundamentals')?.[originKey] ?? {}) };
  const metrics = {};
  for (const [key, s] of Object.entries(fundamentals)) {
    if (!s.length) continue;
    metrics[key] = { ...metricSummary(s), ...(series ? { series: s } : {}) };
  }
  const blockspace = part('blockspace')?.[originKey] ?? null;
  return {
    originKey,
    chainId: meta?.chainId ?? null,
    name: meta?.name ?? originKey,
    ...(meta ? { profile: meta } : {}),
    metrics,
    fees: part('fees')?.[originKey] ?? null,
    activity: part('landing')?.chains?.[originKey] ?? null,
    economics: part('economics')?.[originKey] ?? null,
    blockspace: blockspace ? (series ? blockspace : { '7d': blockspace['7d'] ?? null, '30d': blockspace['30d'] ?? null }) : null,
    daLayersUsed: daUseOf(originKey)
  };
}

function envelope() {
  const files = getGrowthepieStatus().files;
  const live = Object.values(files).filter(f => f.source === 'live').length;
  return {
    attribution: ATTRIBUTION,
    dataSource: live === Object.keys(files).length ? 'live' : live > 0 ? 'partial' : Object.values(files).some(f => f.source) ? 'fallback' : 'unavailable',
    fetchedAt: Object.values(files).map(f => f.fetchedAt).filter(Boolean).sort().at(-1) ?? null
  };
}

const COMPACT_METRICS = ['daa', 'txcount', 'tvl', 'stables_mcap', 'fees_paid_usd', 'profit_usd', 'rent_paid_usd', 'txcosts_median_usd', 'gas_per_second', 'throughput', 'market_cap_usd'];

/** Compact per-chain view: latest of the headline metrics, fees, 30d economics and users. */
function compact(originKey) {
  const full = assemble(originKey);
  const latest = {};
  for (const key of COMPACT_METRICS) {
    const m = full.metrics[key];
    if (m) latest[key] = { value: m.value, date: m.date, change7d: m.change7d, avg7d: m.avg7d, avg7dChange: m.avg7dChange };
  }
  return {
    originKey,
    chainId: full.chainId,
    name: full.name,
    url: full.profile?.url ?? null,
    stack: full.profile?.stack?.label ?? null,
    daLayer: full.profile?.daLayer ?? null,
    l2beatStage: full.profile?.l2beat?.stage ?? null,
    chainType: full.profile?.chainType ?? null,
    metrics: latest,
    txcostMedianUsd: full.fees?.txcosts_median?.usd ?? null,
    users: full.activity?.users ?? null,
    economics30d: full.economics?.['30d'] ?? null
  };
}

// ─── reads ──────────────────────────────────────────────────────────────────

/** Every chain growthepie covers, compact, with the metric labels. */
export async function getL2Metrics() {
  await ensureGrowthepie();
  const chains = origins().filter(o => !['all_l2s', 'multiple'].includes(o)).map(compact)
    .sort((a, b) => (b.metrics.txcount?.value ?? -1) - (a.metrics.txcount?.value ?? -1));
  const aggregate = origins().includes('all_l2s') ? compact('all_l2s') : null;
  return { ...envelope(), count: chains.length, metricsInfo: part('master')?.metrics ?? {}, categories: part('master')?.categories ?? {}, aggregate, chains };
}

/** One chain by EVM chain ID: profile, every metric (with history when `series`), fees, economics, blockspace. */
export async function getL2MetricsForChain(chainId, { series = true } = {}) {
  await ensureGrowthepie();
  const originKey = origins().find(o => chainIdOf(o) === Number(chainId));
  if (!originKey) return null;
  const out = { ...envelope(), ...assemble(originKey, { series }) };
  if (Number(chainId) === 1 && part('ethSupply')) out.ethSupply = part('ethSupply');
  return out;
}

/** The compact block /chains/:id carries; null when growthepie has nothing for the chain. Sync, no fetch. */
export function getL2MetricsBlock(chainId) {
  if (!GROWTHEPIE_ENABLED) return null;
  // Reads what is loaded (or the snapshot); never fetches: the chain detail path must stay
  // network-free. The background timer and the async reads keep the data current.
  loadFallback();
  const originKey = origins().find(o => chainIdOf(o) === Number(chainId));
  if (!originKey) return null;
  const { attribution } = envelope();
  return { ...compact(originKey), attribution };
}

/** Data-availability layers: fees, data posted and consumers per span, with the top consumers. */
export async function getDaLayers() {
  await ensureGrowthepie();
  const da = part('da');
  return { ...envelope(), layers: da?.layers ?? {}, topConsumers: da?.topConsumers ?? {} };
}

/** ETH supply and issuance, with the supply events growthepie lists. */
export async function getEthSupply() {
  await ensureGrowthepie();
  return { ...envelope(), ...(part('ethSupply') ?? { supply: null, issuanceRate: null, supplySeries: [], issuanceSeries: [], events: [] }) };
}

/** Current normalized parts, for the fallback script. */
export function _snapshotParts() {
  return Object.fromEntries(Object.keys(FILES).map(name => [name, part(name)]));
}

/** Test hook: replace the loaded parts (and stop the fallback from loading over them). */
export function _setGrowthepieForTests(parts = {}, { source = 'live', fetchedAt = Date.now() } = {}) {
  stopGrowthepieRefresh();
  state.parts = {};
  state.refreshing = null;
  state.fallbackLoaded = true;
  for (const [name, data] of Object.entries(parts)) state.parts[name] = { data, fetchedAt, source, error: null, lastAttemptAt: fetchedAt };
}
