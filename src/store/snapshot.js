import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DATA_CACHE_ENABLED, DATA_CACHE_FILE } from '../../config.js';
import { logger } from '../util/logger.js';

const SNAPSHOT_SCHEMA_VERSION = 1;
const DATA_CACHE_PATH = resolve(DATA_CACHE_FILE);

export { DATA_CACHE_PATH };

function isValidIndexedData(indexed) {
  if (!indexed || typeof indexed !== 'object') return false;
  return (
    Array.isArray(indexed.all) &&
    indexed.byChainId &&
    typeof indexed.byChainId === 'object' &&
    indexed.byName &&
    typeof indexed.byName === 'object'
  );
}

function isValidSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return false;
  if (typeof snapshot.writtenAt !== 'string') return false;

  const data = snapshot.data;
  if (!data || typeof data !== 'object') return false;
  if (!isValidIndexedData(data.indexed)) return false;
  if (typeof data.lastUpdated !== 'string') return false;

  return true;
}

function createSnapshotPayload(data) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    data: {
      theGraph: data.theGraph ?? null,
      chainlist: data.chainlist ?? null,
      chains: data.chains ?? null,
      // Preserve null (fetch failed) vs {} (fetched, empty) so the freshness
      // signal survives a snapshot round-trip.
      slip44: data.slip44 === undefined ? {} : data.slip44,
      l2beat: data.l2beat ?? null,
      defillama: data.defillama ?? null,
      indexed: data.indexed ?? { byChainId: {}, byName: {}, all: [] },
      lastUpdated: data.lastUpdated ?? new Date().toISOString(),
      rpcHealth: data.rpcHealth ?? {},
      lastRpcCheck: data.lastRpcCheck ?? null
    }
  };
}

export async function readSnapshotFromDisk() {
  if (!DATA_CACHE_ENABLED) return null;

  try {
    const raw = await readFile(DATA_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!isValidSnapshot(parsed)) {
      logger.warn({ path: DATA_CACHE_PATH }, 'Ignoring invalid cache snapshot');
      return null;
    }

    return parsed.data;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    logger.warn({ path: DATA_CACHE_PATH, err: error.message }, 'Failed to read cache snapshot');
    return null;
  }
}

export async function writeSnapshotToDiskAtomic(data) {
  if (!DATA_CACHE_ENABLED) return;

  const snapshot = createSnapshotPayload(data);
  const tempPath = `${DATA_CACHE_PATH}.tmp-${process.pid}-${Date.now()}`;

  try {
    await mkdir(dirname(DATA_CACHE_PATH), { recursive: true });
    await writeFile(tempPath, JSON.stringify(snapshot), 'utf8');
    await rename(tempPath, DATA_CACHE_PATH);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // best-effort temp cleanup
    }
    logger.warn({ path: DATA_CACHE_PATH, err: error.message }, 'Failed to persist cache snapshot');
  }
}
