import { proxyFetch } from './fetchUtil.js';
import {
  PRICE_CACHE_TTL_MS,
  PRICE_NEGATIVE_CACHE_TTL_MS,
  PRICE_FETCH_TIMEOUT_MS,
  PRICE_STALE_AFTER_MS,
} from './config.js';

// chainId → CoinGecko asset id for the chain's NATIVE currency.
//
// Verified on 2026-08-05 against the registry's nativeCurrency.symbol AND against
// CoinGecko's /coins/{id}, because an id that merely RETURNS DATA is not evidence it is the
// right asset — that was the actual defect here. Three distinct problems turned up, and they
// need three different responses:
//
//   WRONG ASSET → replace.
//     matic-network was mapped to chain 137, whose native currency is POL after the
//     migration. It kept serving a quote frozen in Feb 2026, so it read as live and was
//     wrong. Now polygon-ecosystem-token (verified symbol POL, "POL (ex-MATIC)").
//
//   DELISTED → remove the mapping.
//     oec-token (chain 66, OKT) is gone from CoinGecko's catalogue: /coins/oec-token
//     answers "coin not found" and a search for OKT returns nothing, yet /simple/price
//     still serves a husk frozen at $4.96 since Nov 2025. Flagging that as stale would
//     park a permanently unrecoverable number on the chain forever, so chain 66 now has no
//     price at all — which is the truth: we have no source for it.
//
//   QUIET MARKET → keep and let the staleness flag speak.
//     canto (CANTO) and fantom (FTM) both still resolve on /coins/{id}; their markets are
//     thin or gone, not their listings. fantom is deliberately NOT remapped to sonic-3
//     despite market cap 0 and ~$32 volume — chain 250's native currency really is FTM, and
//     substituting Sonic's S would misreport a different asset.
const CHAIN_ID_TO_COINGECKO_ID = {
  1: 'ethereum',
  10: 'ethereum',
  25: 'crypto-com-chain',
  56: 'binancecoin',
  100: 'xdai',
  137: 'polygon-ecosystem-token',
  146: 'sonic-3',
  250: 'fantom',
  288: 'ethereum',
  324: 'ethereum',
  1088: 'metis-token',
  1284: 'moonbeam',
  1285: 'moonriver',
  2222: 'kava',
  5000: 'mantle',
  7700: 'canto',
  8217: 'kaia',
  8453: 'ethereum',
  9001: 'evmos',
  42161: 'ethereum',
  42170: 'ethereum',
  42220: 'celo',
  43114: 'avalanche-2',
  59144: 'ethereum',
  81457: 'ethereum',
  534352: 'ethereum',
  1313161554: 'ethereum',
  1666600000: 'harmony',
};

const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';

// Cache keyed by coinId so sibling chains share a single entry naturally.
// Value: { quote: {usd, vol24h, marketCap, asOf} | null, updatedAt: string }
// A null quote is a negative entry (upstream answered but had no such id) and uses the
// short TTL. `updatedAt` is when WE fetched; `quote.asOf` is when CoinGecko last moved the
// number. Keeping both separate is the whole point — see the note on the URL below.
const priceCache = new Map();

// Coalesce concurrent fetches: one in-flight promise per coinId.
const inflight = new Map();

export function getCoinGeckoId(chainId) {
  return CHAIN_ID_TO_COINGECKO_ID[chainId] ?? null;
}

function isFresh(entry) {
  if (!entry) return false;
  const age = Date.now() - new Date(entry.updatedAt).getTime();
  const ttl = entry.quote === null ? PRICE_NEGATIVE_CACHE_TTL_MS : PRICE_CACHE_TTL_MS;
  return age <= ttl;
}

function getCachedByCoinId(coinId) {
  const entry = priceCache.get(coinId);
  return isFresh(entry) ? entry : null;
}

function toPublic(entry) {
  if (!entry || !entry.quote) return null;
  const q = entry.quote;
  // `stale` is a claim about the UPSTREAM number, not about our cache.
  const stale = q.asOf != null && Date.now() - q.asOf > PRICE_STALE_AFTER_MS;
  return {
    usd: q.usd,
    // The price survives staleness because a last known price plus its age is still
    // informative. Volume and market cap do not: both describe a window that has since
    // closed, so a months-old figure is not a weaker version of the answer, it is a
    // different question. Nulled HERE rather than left to each consumer — the first cut of
    // this had the dashboard hiding them while the API and the MCP tools served them, which
    // is two answers to one question.
    vol24h: stale ? null : q.vol24h,
    marketCap: stale ? null : q.marketCap,
    asOf: q.asOf != null ? new Date(q.asOf).toISOString() : null,
    stale,
    updatedAt: entry.updatedAt
  };
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
  try {
    return await proxyFetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCoinIds(coinIds) {
  if (coinIds.length === 0) return { map: new Map(), ok: true };

  // Coalesce: for each coinId, reuse an in-flight promise if one exists.
  // Otherwise schedule the missing IDs in a single batched request.
  const result = new Map();
  let ok = true;
  const toFetch = [];
  const waiters = [];

  for (const id of coinIds) {
    const pending = inflight.get(id);
    if (pending) {
      waiters.push(pending.then(({ map, ok: pendingOk }) => ({ id, quote: map.get(id), ok: pendingOk })));
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length > 0) {
    const batchPromise = (async () => {
      const map = new Map();
      let batchOk = true;
      // include_last_updated_at is not optional decoration: CoinGecko keeps serving a
      // quote long after an asset's market has moved on, so without the upstream timestamp
      // a six-month-old number is indistinguishable from a live one. See STALE notes on the
      // id map above.
      const url = `${COINGECKO_PRICE_URL}?ids=${toFetch.join(',')}&vs_currencies=usd`
        + '&include_24hr_vol=true&include_market_cap=true&include_last_updated_at=true';
      try {
        const response = await fetchWithTimeout(url);
        if (response.ok) {
          const data = await response.json();
          for (const [id, q] of Object.entries(data)) {
            if (typeof q?.usd !== 'number') continue;
            map.set(id, {
              usd: q.usd,
              // 24h volume of the NATIVE ASSET, not chain throughput. Zero is kept as
              // reported — a dead market genuinely trades nothing.
              vol24h: typeof q.usd_24h_vol === 'number' ? q.usd_24h_vol : null,
              // Observed upstream: -1 for oec-token and 0 for fantom. Neither is a market
              // capitalisation, so both become "unknown" rather than being rendered.
              marketCap: typeof q.usd_market_cap === 'number' && q.usd_market_cap > 0
                ? q.usd_market_cap
                : null,
              asOf: typeof q.last_updated_at === 'number' ? q.last_updated_at * 1000 : null
            });
          }
        } else {
          batchOk = false;
          console.warn(`CoinGecko price fetch failed: HTTP ${response.status}`);
        }
      } catch (err) {
        batchOk = false;
        console.warn(`CoinGecko price fetch error: ${err.message}`);
      }
      return { map, ok: batchOk };
    })();

    for (const id of toFetch) {
      inflight.set(id, batchPromise);
    }
    try {
      const { map, ok: batchOk } = await batchPromise;
      if (!batchOk) ok = false;
      for (const id of toFetch) {
        if (map.has(id)) result.set(id, map.get(id));
      }
    } finally {
      for (const id of toFetch) inflight.delete(id);
    }
  }

  for (const { id, quote, ok: waiterOk } of await Promise.all(waiters.map(p => p))) {
    if (!waiterOk) ok = false;
    if (quote !== undefined) result.set(id, quote);
  }

  return { map: result, ok };
}

function recordResults(coinIds, { map: fetched, ok }) {
  const updatedAt = new Date().toISOString();
  for (const id of coinIds) {
    if (fetched.has(id)) {
      priceCache.set(id, { quote: fetched.get(id), updatedAt });
    } else if (ok) {
      // Upstream succeeded but didn't return this id — it's genuinely missing.
      // Negative-cache with the short TTL so we don't hammer CoinGecko.
      priceCache.set(id, { quote: null, updatedAt });
    }
    // else: upstream failed; leave any prior entry intact so retries can succeed.
  }
}

export async function getPriceForChain(chainId) {
  const coinId = getCoinGeckoId(chainId);
  if (!coinId) return null;

  const cached = getCachedByCoinId(coinId);
  if (cached) return toPublic(cached);

  const fetched = await fetchCoinIds([coinId]);
  recordResults([coinId], fetched);
  return toPublic(priceCache.get(coinId));
}

export async function getPricesForChains(chainIds) {
  const result = new Map();
  const wantedCoinIds = new Set();
  const chainToCoin = new Map();

  for (const chainId of chainIds) {
    const coinId = getCoinGeckoId(chainId);
    if (!coinId) {
      result.set(chainId, null);
      continue;
    }
    chainToCoin.set(chainId, coinId);
    const cached = getCachedByCoinId(coinId);
    if (cached) {
      result.set(chainId, toPublic(cached));
    } else {
      wantedCoinIds.add(coinId);
    }
  }

  if (wantedCoinIds.size > 0) {
    const coinIds = [...wantedCoinIds];
    const fetched = await fetchCoinIds(coinIds);
    recordResults(coinIds, fetched);
  }

  for (const [chainId, coinId] of chainToCoin) {
    if (result.has(chainId)) continue;
    result.set(chainId, toPublic(priceCache.get(coinId)));
  }

  return result;
}

/**
 * Warm the cache for all chainIds with a known CoinGecko mapping.
 * Intended to be called once after data load so the first /chains request
 * doesn't pay a CoinGecko round-trip on the hot path. Failures are silent —
 * a cold cache falls back to per-request fetching with the same timeout.
 */
export async function prefetchAllPrices() {
  const coinIds = [...new Set(Object.values(CHAIN_ID_TO_COINGECKO_ID))];
  const fetched = await fetchCoinIds(coinIds);
  recordResults(coinIds, fetched);
}

export function clearPriceCache() {
  priceCache.clear();
  inflight.clear();
}
