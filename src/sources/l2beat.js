import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_SOURCE_L2BEAT_API, L2BEAT_FETCH_TIMEOUT_MS } from '../../config.js';
import { proxyFetch } from '../../fetchUtil.js';
import { logger } from '../util/logger.js';
import { readStaticJson } from '../util/staticJson.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = join(__dir, '..', '..', 'data', 'l2beat-fallback.json');
const CHAIN_MAP_PATH = join(__dir, '..', '..', 'data', 'l2beat-chain-map.json');

/**
 * Curated L2BEAT slug -> chainId map. L2BEAT's scaling/summary endpoint keys
 * projects by slug and no longer carries a chainId per project, so we supply
 * the join key here. Loaded once at module init.
 */
const SLUG_TO_CHAIN_ID = loadChainMap();

function loadChainMap() {
  const parsed = readStaticJson(CHAIN_MAP_PATH, 'L2BEAT chain map (live projects will lack chainId)');
  const map = new Map();
  for (const [slug, chainId] of Object.entries(parsed?.map ?? {})) {
    const id = Number(chainId);
    if (slug && Number.isSafeInteger(id)) map.set(slug, id);
  }
  return map;
}

/**
 * Fetch L2BEAT scaling-summary data, with graceful fallback to a checked-in
 * static snapshot when the live API is unreachable (404, timeout, network).
 *
 * Returns: { source: 'live'|'fallback'|'unavailable', fetchedAt, projects: [] }
 */
export async function fetchL2Beat() {
  const live = await fetchLive();
  if (live) return live;
  return loadFallback();
}

async function fetchLive() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), L2BEAT_FETCH_TIMEOUT_MS);
  try {
    const response = await proxyFetch(DATA_SOURCE_L2BEAT_API, { signal: controller.signal });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'L2BEAT live fetch failed; falling back to static snapshot');
      return null;
    }
    const json = await response.json();
    const projects = normalizeL2BeatResponse(json);
    if (projects.length === 0) {
      // A 200 that yields zero usable projects means the upstream shape drifted
      // again — prefer the known-good snapshot over silently dropping L2BEAT.
      logger.warn('L2BEAT live fetch returned 0 usable projects; falling back to static snapshot');
      return null;
    }
    return { source: 'live', fetchedAt: new Date().toISOString(), projects };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timeout after ${L2BEAT_FETCH_TIMEOUT_MS}ms` : err.message;
    logger.warn({ reason }, 'L2BEAT live fetch failed; falling back to static snapshot');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadFallback() {
  try {
    const raw = await readFileAsync(FALLBACK_PATH, 'utf8');
    const data = JSON.parse(raw);
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    return { source: 'fallback', fetchedAt: data?.fetchedAt ?? null, projects };
  } catch (err) {
    logger.warn({ err: err.message }, 'L2BEAT fallback unavailable');
    return { source: 'unavailable', fetchedAt: null, projects: [] };
  }
}

/**
 * Normalize L2BEAT's scaling-summary payload to a stable internal shape.
 * Defensive about field names because L2BEAT's site contract is undocumented
 * and has changed shape (projects went from an array to a slug-keyed object,
 * and chainId was dropped — see SLUG_TO_CHAIN_ID).
 */
export function normalizeL2BeatResponse(json) {
  const projects = extractProjectsArray(json);

  // Keep every project that has a slug. chainId may be null when the project
  // isn't in the curated slug→chainId map — those still carry full L2BEAT data
  // (TVS, stage, category, DA) and surface in the scaling list. Only the
  // index/attach step (indexL2BeatSource) needs a chainId, and it already
  // skips entries without a safe-integer chainId.
  return projects
    .map(normalizeProject)
    .filter(p => p.slug);
}

/**
 * Coerce the various shapes L2BEAT has shipped into a flat array of project
 * objects that each carry their own `slug`:
 *   - current:  { projects: { "<slug>": {…} } }  (slug-keyed object)
 *   - legacy:   { projects: [ {…} ] } / { data: { projects: [...] } } / [ ... ]
 */
function extractProjectsArray(json) {
  const p = json?.projects;
  if (p && !Array.isArray(p) && typeof p === 'object') {
    // The object KEY (== value.id, e.g. "optimism", "zksync2") is the stable
    // identifier the chain map is keyed by. A project's own `slug` field is a
    // separate display slug ("op-mainnet", "zksync-era"), so the key must win
    // — spread `value` first, then force `slug` to the key.
    return Object.entries(p).map(([key, value]) => ({ ...value, slug: key }));
  }
  if (Array.isArray(p)) return p;
  if (Array.isArray(json?.data?.projects)) return json.data.projects;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;
  return [];
}

function normalizeProject(p) {
  const slug = p.slug ?? p.id ?? p.display?.slug ?? null;
  return {
    slug,
    displayName: p.name ?? p.display?.name ?? p.displayName ?? null,
    chainId: extractChainId(p, slug),
    category: p.category ?? p.type ?? null,
    stage: extractStage(p),
    stack: p.stack ?? p.providerName ?? p.display?.stack ?? p.providers?.[0] ?? null,
    daLayer: extractDaLayer(p),
    hostChainId: p.hostChain?.chainId ?? p.hostChainId ?? null,
    purposes: Array.isArray(p.purposes) ? p.purposes : [],
    tvs: extractTvs(p),
    tvsBreakdown: p.tvs?.breakdown ?? p.tvsBreakdown ?? null,
    activity: p.activity ?? null,
    links: p.links ?? p.display?.links ?? null,
    riskView: p.riskView ?? null,
    milestones: Array.isArray(p.milestones) ? p.milestones : null
  };
}

function extractChainId(p, slug) {
  const candidate = p.chainId
    ?? p.chainConfig?.chainId
    ?? p.chains?.[0]?.chainId
    ?? p.eip155Id;
  const direct = coerceChainId(candidate);
  if (direct !== null) return direct;
  // New API carries no chainId — resolve via the curated slug map.
  return slug && SLUG_TO_CHAIN_ID.has(slug) ? SLUG_TO_CHAIN_ID.get(slug) : null;
}

/**
 * Coerce an L2BEAT-provided chainId to a finite integer. Handles numbers,
 * decimal strings ("8453"), and CAIP-2 strings ("eip155:8453"). Returns
 * null for anything we can't represent as a safe integer so downstream
 * indexing stays consistent.
 */
function coerceChainId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value === 'string') {
    const match = value.match(/^(?:eip155:)?(\d+)$/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function extractStage(p) {
  if (typeof p.stage === 'string') return p.stage;
  if (typeof p.stage?.stage === 'string') return p.stage.stage;
  if (typeof p.stage?.value === 'string') return p.stage.value;
  return null;
}

function extractDaLayer(p) {
  if (typeof p.daLayer === 'string') return p.daLayer;
  if (typeof p.daLayer?.name === 'string') return p.daLayer.name;
  if (typeof p.dataAvailability?.layer === 'string') return p.dataAvailability.layer;
  // Current API encodes DA as a badge (type: "DA").
  if (Array.isArray(p.badges)) {
    const da = p.badges.find(b => b?.type === 'DA' && typeof b?.name === 'string');
    if (da) return da.name;
  }
  return null;
}

function extractTvs(p) {
  if (typeof p.tvs === 'number') return p.tvs;
  if (typeof p.tvs?.total === 'number') return p.tvs.total;
  if (typeof p.tvs?.breakdown?.total === 'number') return p.tvs.breakdown.total;
  return null;
}
