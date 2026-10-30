import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { authStore } from './store.js';

/**
 * Licence keys: one per licensee (the owner included), issued with src/cli/licenceKeys.js. A key
 * approves MCP connectors on the OAuth consent page, or is sent itself as a bearer token by
 * clients that take a header. Each OAuth grant records the key that approved it, so revoking a
 * key disconnects that licensee's connectors and no one else's. Only the key's hash is stored.
 */
export const KEY_PATTERN = /^cak_[A-Za-z0-9_-]{43}$/;

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const secret = (prefix = '') => prefix + randomBytes(32).toString('base64url');
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A new key for `name`. The key itself is returned once and never stored. */
export async function createLicenceKey(name, store = authStore()) {
  const label = String(name ?? '').trim().slice(0, 200);
  if (!label) throw new Error('A licence key needs a name (the licensee)');
  const key = secret('cak_');
  const record = { id: randomUUID(), name: label, keyHash: sha256(key), createdAt: nowSeconds() };
  await store.createKey(record);
  return { id: record.id, name: label, key };
}

export const listLicenceKeys = (store = authStore()) => store.listKeys();
export const revokeLicenceKey = (id, store = authStore()) => store.revokeKey(id, nowSeconds());

/** The active licensee a key belongs to, or null. */
export async function licenseeForKey(key, store = authStore()) {
  if (!KEY_PATTERN.test(String(key ?? ''))) return null;
  return store.activeKeyByHash(sha256(key));
}
