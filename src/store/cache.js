import { stripPrivateRpcs } from './privateRpcStore.js';

export const cachedData = {
  theGraph: null,
  chainlist: null,
  chains: null,
  slip44: null,
  l2beat: null,
  defillama: null,
  indexed: null,
  lastUpdated: null,
  rpcHealth: {},
  lastRpcCheck: null
};

export function applyDataToCache(data) {
  cachedData.theGraph = data.theGraph ?? null;
  cachedData.chainlist = data.chainlist ?? null;
  cachedData.chains = data.chains ?? null;
  // Preserve null vs {} distinction so /sources can report whether SLIP-0044
  // actually loaded vs returned no rows. Defaults to {} only when caller
  // didn't pass slip44 at all (e.g. test seeds).
  cachedData.slip44 = data.slip44 === undefined ? {} : data.slip44;
  cachedData.l2beat = data.l2beat ?? null;
  cachedData.defillama = data.defillama ?? null;
  cachedData.indexed = data.indexed ?? null;
  cachedData.lastUpdated = data.lastUpdated ?? null;
  cachedData.rpcHealth = data.rpcHealth ?? {};
  cachedData.lastRpcCheck = data.lastRpcCheck ?? null;
  // Endpoints known to require auth (HTTP 401/403) stay dropped across re-fetches.
  stripPrivateRpcs(cachedData.indexed, cachedData.rpcHealth);
}

export function getCachedData() {
  return cachedData;
}
