import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  passwordPolicyError,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH
} from '../../../../src/services/auth/password.js';

const GOOD = 'correct horse battery staple';

describe('password hashing', () => {
  it('stores a PHC-form scrypt hash, never the password', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored).toMatch(/^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(stored).not.toContain(GOOD);
  });

  it('salts every hash, so the same password never stores the same way twice', async () => {
    const [a, b] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);
    expect(a).not.toBe(b);
    const saltOf = (s) => s.split('$')[3];
    expect(saltOf(a)).not.toBe(saltOf(b));
    // …and both still verify.
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword(GOOD);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('treats Unicode-equivalent passwords as the same password (NFKC)', async () => {
    // "é" as one code point vs "e" + combining acute: identical to the person typing it.
    const composed = 'café-passphrase-long';
    const decomposed = 'café-passphrase-long';
    const stored = await hashPassword(composed);
    expect(await verifyPassword(decomposed, stored)).toBe(true);
  });

  it('returns false, without throwing, when there is nothing to verify against', async () => {
    // The route passes `user?.passwordHash` straight through; missing, null and garbage must
    // all simply fail rather than error.
    for (const stored of [undefined, null, '', 'plaintext', '$scrypt$broken', 42]) {
      expect(await verifyPassword(GOOD, stored)).toBe(false);
    }
  });

  it('spends a full derivation even with no stored hash, so timing cannot enumerate accounts', async () => {
    const stored = await hashPassword(GOOD);
    await verifyPassword(GOOD, null); // warm the dummy hash

    const time = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
    const real = await time(() => verifyPassword('wrong password here', stored));
    const missing = await time(() => verifyPassword('wrong password here', null));
    // Same order of magnitude — a missing account must not return near-instantly.
    expect(missing).toBeGreaterThan(real / 4);
  });

  it('refuses a tampered hash with absurd cost parameters instead of pinning the CPU', async () => {
    const stored = await hashPassword(GOOD);
    const tampered = stored.replace('ln=15', 'ln=30');
    expect(await verifyPassword(GOOD, tampered)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassword(GOOD))).toBe(false);
  });

  it('is true for weaker parameters, so they upgrade on the next login', async () => {
    const stored = await hashPassword(GOOD);
    expect(needsRehash(stored.replace('ln=15', 'ln=14'))).toBe(true);
    expect(needsRehash(stored.replace('r=8', 'r=4'))).toBe(true);
  });

  it('is true for anything unparseable', () => {
    expect(needsRehash('nonsense')).toBe(true);
  });
});

describe('passwordPolicyError', () => {
  it('accepts a long passphrase with no composition rules', () => {
    expect(passwordPolicyError(GOOD)).toBeNull();
    expect(passwordPolicyError('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('rejects anything too short or too long', () => {
    expect(passwordPolicyError('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
    expect(passwordPolicyError('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most/);
  });

  it('counts characters, not UTF-16 units, so emoji passphrases are measured fairly', () => {
    // 12 emoji are 24 UTF-16 units; they are still exactly 12 characters.
    expect(passwordPolicyError('🔐'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordPolicyError('🔐'.repeat(PASSWORD_MIN_LENGTH - 1))).toMatch(/at least/);
  });

  it('rejects a non-string', () => {
    expect(passwordPolicyError(undefined)).toMatch(/string/);
    expect(passwordPolicyError(12345678901234)).toMatch(/string/);
  });
});
