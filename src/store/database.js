import {
  CHAINS_API_DB_HOST,
  CHAINS_API_DB_PORT,
  CHAINS_API_DB_NAME,
  CHAINS_API_DB_USER,
  CHAINS_API_DB_PASSWORD
} from '../../config.js';
import { logger } from '../util/logger.js';

/**
 * The chains_api MariaDB: one pool shared by every store that keeps state across pods (RPC
 * health, OAuth and licence keys). Each store registers its tables (registerSchema) when its
 * module loads; they are created on the first connect. Unconfigured or unreachable, database()
 * answers null and each store falls back or refuses as it must; a failed connect is retried
 * after RETRY_AFTER_MS, not on every call.
 */
const schemas = [];
let createPoolImpl = defaultCreatePool;
let pool = null;
let initPromise = null;
let lastWarnAt = 0;
let retryAt = 0;
const WARN_EVERY_MS = 60000;
const RETRY_AFTER_MS = 60000;

export function databaseConfigured() {
  return Boolean(CHAINS_API_DB_HOST && CHAINS_API_DB_USER && CHAINS_API_DB_PASSWORD);
}

/** Tables a store needs, as CREATE TABLE IF NOT EXISTS statements. */
export function registerSchema(...ddl) {
  for (const statement of ddl) if (!schemas.includes(statement)) schemas.push(statement);
}

async function defaultCreatePool() {
  const mod = await import('mariadb');
  const mariadb = mod.default ?? mod;
  return mariadb.createPool({
    host: CHAINS_API_DB_HOST,
    port: CHAINS_API_DB_PORT,
    database: CHAINS_API_DB_NAME,
    user: CHAINS_API_DB_USER,
    password: CHAINS_API_DB_PASSWORD,
    connectionLimit: 5,
    acquireTimeout: 10000,
    connectTimeout: 5000,
    // BIGINT IDs and times come back as numbers, not BigInt.
    bigIntAsNumber: true
  });
}

export function warnDatabase(err, msg) {
  if (Date.now() - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = Date.now();
  logger.warn({ err: err.message }, msg);
}

/** The pool, with every registered table created; null when unconfigured or unreachable. */
export async function database() {
  if (!databaseConfigured()) return null;
  if (!initPromise && Date.now() < retryAt) return null;
  initPromise ??= (async () => {
    try {
      const p = await createPoolImpl();
      for (const ddl of schemas) await p.query(ddl);
      pool = p;
      logger.info({ host: CHAINS_API_DB_HOST, database: CHAINS_API_DB_NAME, tables: schemas.length }, 'MariaDB connected');
      return p;
    } catch (err) {
      warnDatabase(err, 'MariaDB unavailable');
      retryAt = Date.now() + RETRY_AFTER_MS;
      initPromise = null;
      return null;
    }
  })();
  return initPromise;
}

export async function closeDatabase() {
  const p = pool;
  pool = null;
  initPromise = null;
  if (p) await p.end().catch(() => {});
}

export function _setCreatePoolForTests(fn) {
  createPoolImpl = fn ?? defaultCreatePool;
  pool = null;
  initPromise = null;
  lastWarnAt = 0;
  retryAt = 0;
}
