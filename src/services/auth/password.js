import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Salted password hashing.
 *
 * scrypt rather than a fast hash: the point of a password KDF is to make each guess expensive
 * after a credential file leaks, and scrypt is memory-hard, so an attacker cannot buy the
 * speed back with GPUs the way they can against SHA-anything. It ships in Node's own crypto,
 * so this needs no native dependency — bcrypt and argon2 bindings both would, and a native
 * build step is the one thing this deliberately dependency-light service has avoided.
 *
 * Every password gets its own 16-byte random salt, so two users with the same password store
 * different hashes and no precomputed table applies. The salt is not a secret; it travels in
 * the stored string next to the hash.
 *
 * Stored in PHC string form, `$scrypt$ln=15,r=8,p=1$<salt>$<hash>`, so the cost parameters
 * live WITH each hash. Raising them later is then a code change plus a rehash on the next
 * successful login (see needsRehash), never a migration that needs every user's password.
 */

// OWASP's scrypt guidance: N=2^17 is the strong end, 2^15 the documented floor for
// interactive logins. 2^15 keeps a verify around ~100 ms on modest hardware, which matters
// because login is also a DoS surface.
const PARAMS = { ln: 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs 128·N·r bytes; Node's 32 MiB default sits exactly at that line for these
// params and refuses anything above it, so give headroom rather than fail on a future bump.
const MAX_MEM = 128 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 12;
// Long passphrases are welcome; an unbounded one is a free way to make the server hash a
// megabyte on every request.
export const PASSWORD_MAX_LENGTH = 256;

const b64 = (buf) => buf.toString('base64').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(s, 'base64');

function derive(password, salt, { ln, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: 2 ** ln, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// NIST SP 800-63B §5.1.1.2: normalize before hashing, so the same passphrase typed on two
// keyboards that compose "é" differently is the same password.
function normalize(password) {
  return String(password).normalize('NFKC');
}

function parse(stored) {
  if (typeof stored !== 'string') return null;
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!m) return null;
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // Reject absurd stored parameters instead of letting a tampered file pin the CPU.
  if (params.ln < 10 || params.ln > 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) {
    return null;
  }
  return { params, salt: unb64(m[4]), hash: unb64(m[5]) };
}

/**
 * Why a password is unacceptable, or null when it is fine. Length only: NIST 800-63B advises
 * against composition rules (they push people to "Password1!"), and length is what actually
 * buys entropy.
 *
 * @param {unknown} password
 * @returns {string|null}
 */
export function passwordPolicyError(password) {
  if (typeof password !== 'string') return 'Password must be a string';
  const length = [...normalize(password)].length;
  if (length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}

/**
 * @param {string} password plaintext
 * @returns {Promise<string>} PHC-form hash with its own random salt
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(normalize(password), salt, PARAMS);
  return `$scrypt$ln=${PARAMS.ln},r=${PARAMS.r},p=${PARAMS.p}$${b64(salt)}$${b64(hash)}`;
}

// A real hash of a random password, computed once. verifyPassword runs against it whenever
// there is nothing to verify against, so "no such account" and "account without a password"
// cost the same time as a wrong password and response timing cannot enumerate accounts.
let dummyHash = null;
async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  return dummyHash;
}

/**
 * Constant-time check of a password against a stored hash.
 *
 * Always performs a full derivation, even when `stored` is missing or malformed, so a caller
 * can pass `user?.passwordHash` straight through without leaking which case it was.
 *
 * @param {string} password plaintext attempt
 * @param {string|null|undefined} stored PHC-form hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  const parsed = parse(stored);
  const target = parsed ?? parse(await getDummyHash());
  const attempt = await derive(normalize(password ?? ''), target.salt, target.params);
  const match = attempt.length === target.hash.length && timingSafeEqual(attempt, target.hash);
  return Boolean(parsed) && match;
}

/**
 * True when a stored hash uses weaker parameters than the current ones, so the caller can
 * transparently re-hash on the next successful login.
 *
 * @param {string} stored
 * @returns {boolean}
 */
export function needsRehash(stored) {
  const parsed = parse(stored);
  if (!parsed) return true;
  return parsed.params.ln < PARAMS.ln || parsed.params.r !== PARAMS.r || parsed.params.p !== PARAMS.p;
}
