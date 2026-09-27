import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStore, hashToken, normalizeEmail } from '../../../../src/services/auth/store.js';

const DAY = 24 * 60 * 60 * 1000;

describe('auth store', () => {
  let dir;
  let file;
  let clock;
  const now = () => clock;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'auth-store-'));
    file = join(dir, 'auth.json');
    clock = Date.parse('2026-09-27T00:00:00Z');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('accounts', () => {
    it('creates a user once per email, ignoring case and surrounding space', async () => {
      const store = createAuthStore({ file, now });
      const a = await store.createUser('  Alice@Example.COM ');
      const b = await store.createUser('alice@example.com');
      expect(b.id).toBe(a.id);
      expect(a.email).toBe('alice@example.com');
      expect((await store.findUserByEmail('ALICE@example.com')).id).toBe(a.id);
      expect(await store.findUserByEmail('bob@example.com')).toBeNull();
    });

    it('starts without a password and records when one is set', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      expect(user.passwordHash).toBeNull();
      await store.setPasswordHash(user.id, '$scrypt$fake');
      const reloaded = await store.getUser(user.id);
      expect(reloaded.passwordHash).toBe('$scrypt$fake');
      expect(reloaded.passwordUpdatedAt).toBe(new Date(clock).toISOString());
    });

    it('refuses to set a password for a user that does not exist', async () => {
      const store = createAuthStore({ file, now });
      await expect(store.setPasswordHash('nope', 'x')).rejects.toThrow('No such user');
    });
  });

  describe('sessions', () => {
    it('returns the plaintext token once and stores only its hash', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      const { token } = await store.createSession(user.id, DAY);
      await store.flush();

      const onDisk = await readFile(file, 'utf8');
      expect(onDisk).not.toContain(token);
      expect(onDisk).toContain(hashToken(token));
    });

    it('resolves a live token to its session and user', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      const { token } = await store.createSession(user.id, DAY);
      const found = await store.getSession(token);
      expect(found.user.id).toBe(user.id);
    });

    it('rejects an unknown or empty token', async () => {
      const store = createAuthStore({ file, now });
      expect(await store.getSession('not-a-token')).toBeNull();
      expect(await store.getSession('')).toBeNull();
      expect(await store.getSession(undefined)).toBeNull();
    });

    it('expires a session at its deadline', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      const { token } = await store.createSession(user.id, DAY);
      clock += DAY;
      expect(await store.getSession(token)).toBeNull();
    });

    it('revokes one session, or all of a user\'s sessions except the current one', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      const s1 = await store.createSession(user.id, DAY);
      const s2 = await store.createSession(user.id, DAY);
      const s3 = await store.createSession(user.id, DAY);

      expect(await store.revokeSession(s1.token)).toBe(true);
      expect(await store.getSession(s1.token)).toBeNull();

      expect(await store.revokeAllSessions(user.id, { exceptToken: s3.token })).toBe(1);
      expect(await store.getSession(s2.token)).toBeNull();
      expect(await store.getSession(s3.token)).not.toBeNull();

      expect(await store.revokeAllSessions(user.id)).toBe(1);
      expect(await store.getSession(s3.token)).toBeNull();
    });

    it('caps sessions per user, evicting the oldest', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      const first = await store.createSession(user.id, DAY);
      for (let i = 0; i < 20; i++) { clock += 1; await store.createSession(user.id, DAY); }
      expect(await store.getSession(first.token)).toBeNull();
    });
  });

  describe('persistence', () => {
    it('survives a restart: accounts, passwords and sessions reload from disk', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      await store.setPasswordHash(user.id, '$scrypt$fake');
      const { token } = await store.createSession(user.id, DAY);
      await store.flush();

      const restarted = createAuthStore({ file, now });
      expect((await restarted.findUserByEmail('a@x.io')).passwordHash).toBe('$scrypt$fake');
      expect((await restarted.getSession(token)).user.email).toBe('a@x.io');
    });

    it('writes the file owner-only (0600)', async () => {
      const store = createAuthStore({ file, now });
      await store.createUser('a@x.io');
      await store.flush();
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    });

    it('drops expired sessions when it loads', async () => {
      const store = createAuthStore({ file, now });
      const user = await store.createUser('a@x.io');
      const { token } = await store.createSession(user.id, DAY);
      await store.flush();

      clock += 2 * DAY;
      const restarted = createAuthStore({ file, now });
      expect(await restarted.getSession(token)).toBeNull();
    });

    it('treats a missing file as a first run', async () => {
      const store = createAuthStore({ file: join(dir, 'nested', 'auth.json'), now });
      expect(await store.findUserByEmail('a@x.io')).toBeNull();
    });

    it('refuses to start on a corrupt file rather than silently wiping every account', async () => {
      await writeFile(file, '{ this is not json');
      const store = createAuthStore({ file, now });
      await expect(store.findUserByEmail('a@x.io')).rejects.toThrow(/refusing to start/);
    });

    it('keeps the final state when writes overlap', async () => {
      const store = createAuthStore({ file, now });
      await Promise.all(['a@x.io', 'b@x.io', 'c@x.io'].map((e) => store.createUser(e)));
      await store.flush();
      const onDisk = JSON.parse(await readFile(file, 'utf8'));
      expect(onDisk.users.map((u) => u.email).sort()).toEqual(['a@x.io', 'b@x.io', 'c@x.io']);
    });
  });

  it('normalizeEmail trims and lowercases', () => {
    expect(normalizeEmail('  Foo@Bar.IO ')).toBe('foo@bar.io');
    expect(normalizeEmail(undefined)).toBe('');
  });
});
