import {
  BLOCKSCOUT_ENABLED,
  BLOCKSCOUT_CACHE_TTL_MS,
  BLOCKSCOUT_INSTANCE_CACHE_TTL_MS,
  BLOCKSCOUT_FETCH_TIMEOUT_MS,
  BLOCKSCOUT_MAX_RPS
} from '../../config.js';
import { proxyFetch } from '../../fetchUtil.js';
import { getChainById } from '../store/queries.js';
import { logger } from '../util/logger.js';
import { safeExternalUrl } from '../util/publicHost.js';

/**
 * Keyless Blockscout client, used by the chain-halt check as an independent
 * non-RPC witness: a chain's own RPC endpoints can agree with each other and
 * still all be wrong, so a second opinion from a different stack is what makes
 * a halt verdict trustworthy.
 *
 * Everything here is best-effort. Every public function returns null rather
 * than throwing, because ~2200 of the ~2700 registry chains have no Blockscout
 * instance at all and the caller must degrade to RPC-only, not fail.
 *
 * Rate limits (measured 2026-08-07): per-instance endpoints need no API key and
 * cap at 10 rps per IP, reporting `x-ratelimit-limit` / `-remaining` / `-reset`.
 * The whole pod shares one egress IP, so requests are paced well under that and
 * a 429 parks the host instead of retrying — a retry storm is what gets an IP
 * blocked.
 *
 * Blockscout has announced that per-instance APIs retire in favour of the keyed
 * api.blockscout.com. `statsUrl()` is the single place that knows the URL shape,
 * so that migration stays a one-function change.
 */

// A single request to this endpoint yields everything the halt check needs:
// the tip's height and timestamp, plus enough history to derive the average
// block interval. Verified against /api/v2/stats on Ethereum: both give 12.00s.
const BLOCKS_PATH = '/api/v2/blocks?type=block';

// Hard cap on a single explorer response. A declared content-length is only a claim, so the
// decoded length is checked too — UTF-8 is at least one byte per character, so a string longer
// than the cap proves the body was over it.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// chainId -> { baseUrl: string|null, at: number }. Negative entries matter as
// much as positive ones: they keep the ~2200 explorer-less chains from being
// re-probed on every question.
let instanceCache = new Map();
// chainId -> { data: object|null, at: number }
let statsCache = new Map();
// chainId -> Promise, so concurrent questions about one chain share a request.
const inflight = new Map();
// host -> epoch ms until which the host is parked after a 429.
const parked = new Map();

let lastRequestAt = 0;

export function _resetBlockscoutCacheForTests() {
  instanceCache = new Map();
  statsCache = new Map();
  inflight.clear();
  parked.clear();
  lastRequestAt = 0;
}

/**
 * Build the request URL for an instance. The only place that knows the
 * per-instance URL shape — see the migration note above.
 */
function blocksUrl(baseUrl) {
  return `${baseUrl}${BLOCKS_PATH}`;
}

function isFresh(entry, ttlMs) {
  return Boolean(entry) && Date.now() - entry.at < ttlMs;
}

/**
 * Pace requests to stay under the shared per-IP ceiling. Serialising on a
 * minimum interval is deliberately cruder than a token bucket: it also
 * flattens bursts, which is what a shared IP actually needs.
 */
async function pace() {
  const minInterval = Math.ceil(1000 / Math.max(1, BLOCKSCOUT_MAX_RPS));
  const wait = lastRequestAt + minInterval - Date.now();
  lastRequestAt = Math.max(Date.now(), lastRequestAt + minInterval);
  if (wait > 0) {
    logger.debug({ waitMs: wait }, 'Blockscout request paced');
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Fetch and parse JSON from an instance, honouring the park list.
 * @returns {Promise<object|null>} null on any failure — never throws.
 */
async function fetchJson(url) {
  const host = hostOf(url);
  const parkedUntil = parked.get(host);
  if (parkedUntil && Date.now() < parkedUntil) {
    logger.debug({ host }, 'Blockscout host parked after 429; skipping');
    return null;
  }

  await pace();
  try {
    const response = await proxyFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(BLOCKSCOUT_FETCH_TIMEOUT_MS)
    });
    if (response.status === 429) {
      // Park for as long as the instance says, so the next caller doesn't walk
      // straight back into the limit. Fall back to a second if the header is
      // missing or nonsense.
      const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10);
      const parkMs = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 300) * 1000 : 1000;
      parked.set(host, Date.now() + parkMs);
      logger.warn({ host, parkMs }, 'Blockscout rate limited; parking host');
      return null;
    }
    if (!response.ok) return null;
    // Cap the body. This is a third-party host reached over a URL taken from a community
    // registry, so its response size is not ours to trust — and response.json() buffers
    // whatever arrives. A blocks listing is a few tens of KB; 2 MiB is ~50x headroom.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      logger.warn({ url, declared }, 'Blockscout response too large; ignoring');
      return null;
    }
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) {
      logger.warn({ url, bytes: text.length }, 'Blockscout response exceeded the cap; ignoring');
      return null;
    }
    return JSON.parse(text);
  } catch (err) {
    logger.debug({ url, err: err.message }, 'Blockscout request failed');
    return null;
  }
}

/**
 * Candidate instance base URLs for a chain, most likely first.
 *
 * Two explorer shapes exist in the store: chains.json contributes
 * `[{name, url, icon, standard}]` and the TheGraph registry contributes plain
 * strings (`src/store/indexer.js`). Only Blockscout-looking entries are
 * considered — probing all ~2250 chains that have any explorer would be a lot
 * of requests to find the ~450 that are Blockscout.
 */
function candidateUrls(chain) {
  const explorers = Array.isArray(chain?.explorers) ? chain.explorers : [];
  const urls = [];
  for (const entry of explorers) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    // Explorer URLs arrive from the community-maintained registry, so they are input rather
    // than configuration: reject anything not http(s) to a publicly routable host.
    if (safeExternalUrl(url) === null) continue;
    const haystack = `${url} ${typeof entry === 'string' ? '' : `${entry?.name ?? ''} ${entry?.icon ?? ''}`}`;
    if (!/blockscout/i.test(haystack)) continue;
    const trimmed = url.replace(/\/+$/, '');
    if (!urls.includes(trimmed)) urls.push(trimmed);
  }
  // Two attempts is plenty: a chain listing three Blockscout mirrors that are
  // all down is not worth a third round trip on every halt check.
  return urls.slice(0, 2);
}

/**
 * Resolve which Blockscout instance serves a chain, verifying the API actually
 * answers. A URL containing "blockscout" is not proof the instance is up, and
 * an unverified base URL would turn every halt check into a failed request.
 *
 * @returns {Promise<{baseUrl: string, payload: object}|null>}
 */
async function resolveInstance(chainId) {
  const cached = instanceCache.get(chainId);
  if (isFresh(cached, BLOCKSCOUT_INSTANCE_CACHE_TTL_MS)) {
    return cached.baseUrl ? { baseUrl: cached.baseUrl, payload: null } : null;
  }

  const chain = getChainById(chainId);
  for (const baseUrl of candidateUrls(chain)) {
    const payload = await fetchJson(blocksUrl(baseUrl));
    if (Array.isArray(payload?.items) && payload.items.length > 0) {
      instanceCache.set(chainId, { baseUrl, at: Date.now() });
      // Hand back the payload: resolution just fetched exactly what the caller
      // wants, so making it fetch again would double every cold request.
      return { baseUrl, payload };
    }
  }

  instanceCache.set(chainId, { baseUrl: null, at: Date.now() });
  return null;
}

/**
 * Derive the tip and the average block interval from a blocks listing.
 * @returns {{height: number, timestampMs: number, averageBlockSeconds: number|null}|null}
 */
function summarize(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const usable = items
    .map((b) => ({ height: Number(b?.height), timestampMs: Date.parse(b?.timestamp) }))
    .filter((b) => Number.isFinite(b.height) && Number.isFinite(b.timestampMs));
  if (usable.length === 0) return null;

  const tip = usable[0];
  const oldest = usable[usable.length - 1];
  const blockSpan = tip.height - oldest.height;
  const secondSpan = (tip.timestampMs - oldest.timestampMs) / 1000;
  // The listing is not always contiguous, so divide by the height span rather
  // than the item count. Guard the single-item and non-monotonic cases.
  const averageBlockSeconds = blockSpan > 0 && secondSpan > 0 ? secondSpan / blockSpan : null;

  return { height: tip.height, timestampMs: tip.timestampMs, averageBlockSeconds };
}

/**
 * The explorer's view of a chain's tip.
 *
 * @param {number} chainId
 * @returns {Promise<{baseUrl: string, height: number, timestampMs: number,
 *   averageBlockSeconds: number|null}|null>} null when the chain has no
 *   reachable Blockscout instance — which is the common case and means
 *   "no second opinion available", never "the chain is down".
 */
export async function getExplorerTip(chainId) {
  if (!BLOCKSCOUT_ENABLED) return null;

  const cached = statsCache.get(chainId);
  if (isFresh(cached, BLOCKSCOUT_CACHE_TTL_MS)) return cached.data;

  const pending = inflight.get(chainId);
  if (pending) return pending;

  const promise = (async () => {
    let data = null;
    const resolved = await resolveInstance(chainId);
    if (resolved) {
      const payload = resolved.payload ?? (await fetchJson(blocksUrl(resolved.baseUrl)));
      const summary = summarize(payload);
      if (summary) data = { baseUrl: resolved.baseUrl, ...summary };
    }
    // Cache the miss too: without it, an explorer-less chain re-probes on every
    // question at exactly the moment the user is asking repeatedly.
    statsCache.set(chainId, { data, at: Date.now() });
    return data;
  })().finally(() => inflight.delete(chainId));

  inflight.set(chainId, promise);
  return promise;
}
