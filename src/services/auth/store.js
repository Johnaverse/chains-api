import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Accounts and sessions, persisted without a database.
 *
 * This service has no database by design, and feedback.js already set the precedent of a
 * small file beside the data cache. Auth follows it with two deliberate differences:
 *
 *   Atomic writes. feedback.jsonl can afford a torn last line; an auth file cannot, because a
 *   half-written file loses every account. Writes go to a temp file and are renamed into
 *   place, which POSIX makes atomic, and they are serialized so two logins cannot interleave.
 *
 *   Only hashes of secrets. Session tokens are stored as SHA-256 digests. The plaintext token
 *   exists in exactly two places — the Set-Cookie response and the browser — so a leaked
 *   auth.json, a backup, or a debug dump contains nothing an attacker can replay. SHA-256 is
 *   correct here where passwords need scrypt: a 256-bit random token has no dictionary to
 *   search, so hashing speed buys an attacker nothing.
 *
 * Constraint worth knowing at deploy time: this is a single-process store. Run one replica
 * (as the feedback store already requires), or put the file on a shared volume with sticky
 * sessions — two replicas with separate files will each reject the other's sessions.
 */

const SESSION_CAP_PER_USER = 20;

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

/** Case and surrounding space are not part of an email address anyone means to type. */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/**
 * @param {object} options
 * @param {string} options.file path of the JSON store
 * @param {() => number} [options.now] clock, injectable for tests
 */
export function createAuthStore({ file, now = Date.now }) {
  const users = new Map();      // id → user
  const byEmail = new Map();    // normalized email → id
  const sessions = new Map();   // tokenHash → session
  let loaded = null;
  let writeChain = Promise.resolve();

  function snapshot() {
    return JSON.stringify({
      version: 1,
      users: [...users.values()],
      sessions: [...sessions.values()]
    }, null, 2);
  }

  async function persist() {
    // Serialize: each write waits for the previous one, and each writes the state as it is
    // when its turn comes, so the file always ends at the latest state.
    writeChain = writeChain.catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot(), { mode: 0o600 });
      await rename(tmp, file);
      // rename keeps the temp file's mode, but an umask can interfere on creation; enforce it.
      await chmod(file, 0o600).catch(() => {});
    });
    return writeChain;
  }

  function pruneExpired() {
    const t = now();
    let changed = false;
    for (const [key, s] of sessions) {
      if (s.expiresAt <= t) { sessions.delete(key); changed = true; }
    }
    return changed;
  }

  async function load() {
    if (!loaded) {
      loaded = (async () => {
        let raw;
        try {
          raw = await readFile(file, 'utf8');
        } catch (err) {
          if (err?.code === 'ENOENT') return; // first run
          throw err;
        }
        // A corrupt auth file is a stop, not a reset. Silently starting empty would wipe every
        // account and its password — and the next write would make that permanent.
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error(`Auth store ${file} is not valid JSON; refusing to start with an empty user list`);
        }
        for (const u of Array.isArray(data?.users) ? data.users : []) {
          if (!u?.id || !u?.email) continue;
          users.set(u.id, u);
          byEmail.set(normalizeEmail(u.email), u.id);
        }
        for (const s of Array.isArray(data?.sessions) ? data.sessions : []) {
          if (s?.tokenHash && users.has(s.userId)) sessions.set(s.tokenHash, s);
        }
        pruneExpired();
      })();
    }
    return loaded;
  }

  return {
    load,

    async findUserByEmail(email) {
      await load();
      const id = byEmail.get(normalizeEmail(email));
      return id ? users.get(id) : null;
    },

    async getUser(id) {
      await load();
      return users.get(id) ?? null;
    },

    async createUser(email) {
      await load();
      const key = normalizeEmail(email);
      const existing = byEmail.get(key);
      if (existing) return users.get(existing);
      const user = {
        id: randomUUID(),
        email: key,
        passwordHash: null,
        createdAt: new Date(now()).toISOString(),
        passwordUpdatedAt: null,
        lastLoginAt: null
      };
      users.set(user.id, user);
      byEmail.set(key, user.id);
      await persist();
      return user;
    },

    async setPasswordHash(userId, passwordHash) {
      await load();
      const user = users.get(userId);
      if (!user) throw new Error('No such user');
      user.passwordHash = passwordHash;
      user.passwordUpdatedAt = new Date(now()).toISOString();
      await persist();
      return user;
    },

    async recordLogin(userId) {
      await load();
      const user = users.get(userId);
      if (!user) return;
      user.lastLoginAt = new Date(now()).toISOString();
      await persist();
    },

    /**
     * @returns {Promise<{token: string, session: object}>} the plaintext token, returned
     *   exactly once — only its hash is kept
     */
    async createSession(userId, ttlMs) {
      await load();
      if (!users.has(userId)) throw new Error('No such user');
      pruneExpired();
      const token = newToken();
      const t = now();
      const session = { tokenHash: hashToken(token), userId, createdAt: t, lastSeenAt: t, expiresAt: t + ttlMs };
      sessions.set(session.tokenHash, session);

      // Bound the list: a script hammering login must not grow the file without limit.
      const mine = [...sessions.values()].filter((s) => s.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
      for (const old of mine.slice(0, Math.max(0, mine.length - SESSION_CAP_PER_USER))) {
        sessions.delete(old.tokenHash);
      }
      await persist();
      return { token, session };
    },

    /** @returns {Promise<{session: object, user: object}|null>} */
    async getSession(token) {
      if (!token) return null;
      await load();
      const session = sessions.get(hashToken(token));
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(session.tokenHash);
        await persist();
        return null;
      }
      const user = users.get(session.userId);
      if (!user) return null;
      // Deliberately not persisted on every request: lastSeenAt is informational, and writing
      // the file on each authenticated read would turn reads into disk writes.
      session.lastSeenAt = now();
      return { session, user };
    },

    async revokeSession(token) {
      if (!token) return false;
      await load();
      const removed = sessions.delete(hashToken(token));
      if (removed) await persist();
      return removed;
    },

    /**
     * Revoke every session for a user, optionally keeping one (the request making the change).
     * @returns {Promise<number>} sessions revoked
     */
    async revokeAllSessions(userId, { exceptToken } = {}) {
      await load();
      const keep = exceptToken ? hashToken(exceptToken) : null;
      let n = 0;
      for (const [key, s] of sessions) {
        if (s.userId === userId && key !== keep) { sessions.delete(key); n += 1; }
      }
      if (n) await persist();
      return n;
    },

    /** Resolves when every queued write has reached disk. */
    flush() {
      return writeChain.catch(() => {});
    }
  };
}
