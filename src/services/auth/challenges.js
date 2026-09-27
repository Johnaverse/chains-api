import { randomInt, timingSafeEqual } from 'node:crypto';
import { hashToken, newToken, normalizeEmail } from './store.js';

/**
 * Email challenges — the "check your email" step, for signing in and for resetting a password.
 *
 * One challenge carries TWO ways to finish it, and that pairing is the PWA design:
 *
 *   The magic link is the convenient path, but an installed PWA is a separate browser
 *   context. On iOS, and anywhere links are not captured into the app, tapping the link opens
 *   the system browser and the sign-in lands THERE, not in the app window the user started
 *   from.
 *
 *   The 6-digit code is the path that always works: read it in the mail app, type it into the
 *   PWA. It is bound to the attemptId that only the initiating window holds, so a code alone
 *   is useless to anyone else.
 *
 * Both finish the same challenge, and consuming either consumes the challenge — a used link
 * cannot be followed by the code, or the reverse.
 *
 * Challenges live in memory only. They are short-lived by design, so a restart simply means
 * "request a new code", and no plaintext code or token ever reaches disk.
 */

export const PURPOSES = Object.freeze({ LOGIN: 'login', RESET: 'reset' });

const DEFAULT_TTL = {
  [PURPOSES.LOGIN]: 10 * 60 * 1000,
  // Longer for reset: a person choosing a new password is slower than one typing a code.
  [PURPOSES.RESET]: 30 * 60 * 1000
};

const CODE_DIGITS = 6;
// Five wrong guesses at a 1-in-a-million code is a 0.0005% chance before the challenge dies.
const MAX_CODE_ATTEMPTS = 5;
// Per-address send budget. Without it, "email me a code" is a free way to bomb someone's
// inbox from our domain and burn the SMTP account's reputation.
const SEND_WINDOW_MS = 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const MAX_LIVE_CHALLENGES = 10_000;

function codeDigest(attemptKey, code) {
  // Bound to the attempt, so the same code on two concurrent challenges is two digests.
  return hashToken(`${attemptKey}:${code}`);
}

function sameDigest(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {Record<string, number>} [options.ttl] per-purpose lifetime in ms
 */
export function createChallengeService({ now = Date.now, ttl = DEFAULT_TTL } = {}) {
  const byAttempt = new Map();   // hash(attemptId) → challenge
  const byLink = new Map();      // hash(linkToken) → attempt key
  const sends = new Map();       // `${purpose}:${email}` → [timestamps]

  function remove(key) {
    const c = byAttempt.get(key);
    if (!c) return;
    byAttempt.delete(key);
    byLink.delete(c.linkKey);
  }

  function prune() {
    const t = now();
    for (const [key, c] of byAttempt) if (c.expiresAt <= t) remove(key);
    for (const [k, times] of sends) {
      const fresh = times.filter((x) => x > t - SEND_WINDOW_MS);
      if (fresh.length) sends.set(k, fresh); else sends.delete(k);
    }
    // Hard ceiling on memory whatever the traffic: oldest first.
    while (byAttempt.size > MAX_LIVE_CHALLENGES) remove(byAttempt.keys().next().value);
  }

  function underBudget(purpose, email) {
    const k = `${purpose}:${email}`;
    const t = now();
    const recent = (sends.get(k) ?? []).filter((x) => x > t - SEND_WINDOW_MS);
    if (recent.length >= MAX_SENDS_PER_WINDOW) return false;
    recent.push(t);
    sends.set(k, recent);
    return true;
  }

  return {
    /**
     * Open a challenge.
     *
     * Returns `deliver: false` when this address is over its send budget. The caller must
     * then respond exactly as if an email went out — a different response would tell anyone
     * who asks that someone else has been requesting codes for that address.
     *
     * @param {object} input
     * @param {string} input.purpose one of PURPOSES
     * @param {string} input.email
     * @param {string|null} [input.userId] null when the account does not exist yet
     * @returns {{attemptId: string, code: string, linkToken: string, expiresAt: number, deliver: boolean}}
     */
    issue({ purpose, email, userId = null }) {
      if (!Object.values(PURPOSES).includes(purpose)) throw new Error(`Unknown purpose: ${purpose}`);
      prune();
      const address = normalizeEmail(email);

      // A fresh request supersedes any earlier one for the same address and purpose, so only
      // the newest email in the inbox works — the behaviour people expect when they hit
      // "resend", and it keeps a stale code from lingering after a newer one was used.
      for (const [key, c] of byAttempt) {
        if (c.purpose === purpose && c.email === address) remove(key);
      }

      const attemptId = newToken();
      const linkToken = newToken();
      const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
      const key = hashToken(attemptId);
      const expiresAt = now() + (ttl[purpose] ?? DEFAULT_TTL[purpose]);
      const deliver = underBudget(purpose, address);

      // Over budget: hand back an attempt that can never succeed. Its id, code and link are
      // well-formed but none is stored, so every check fails the same way an expired one does.
      if (deliver) {
        const linkKey = hashToken(linkToken);
        byAttempt.set(key, {
          purpose,
          email: address,
          userId,
          codeHash: codeDigest(key, code),
          linkKey,
          attempts: 0,
          expiresAt
        });
        byLink.set(linkKey, key);
      }
      return { attemptId, code, linkToken, expiresAt, deliver };
    },

    /**
     * Finish a challenge with the typed code. Needs the attemptId as well, which only the
     * window that started the attempt holds.
     *
     * @returns {{ok: true, challenge: object} | {ok: false, reason: string}} `reason` is for
     *   logs and tests; callers must show one generic failure, or the difference between
     *   "wrong", "expired" and "locked" becomes an oracle.
     */
    verifyCode({ purpose, attemptId, code }) {
      if (!attemptId || typeof code !== 'string') return { ok: false, reason: 'invalid' };
      const key = hashToken(attemptId);
      const c = byAttempt.get(key);
      if (!c || c.purpose !== purpose) return { ok: false, reason: 'invalid' };
      if (c.expiresAt <= now()) { remove(key); return { ok: false, reason: 'expired' }; }

      const cleaned = code.replace(/\s|-/g, '');
      if (/^\d{6}$/.test(cleaned) && sameDigest(codeDigest(key, cleaned), c.codeHash)) {
        remove(key);
        return { ok: true, challenge: { purpose: c.purpose, email: c.email, userId: c.userId } };
      }
      c.attempts += 1;
      if (c.attempts >= MAX_CODE_ATTEMPTS) { remove(key); return { ok: false, reason: 'locked' }; }
      return { ok: false, reason: 'invalid' };
    },

    /**
     * Finish a challenge with the magic-link token.
     * @returns {{ok: true, challenge: object} | {ok: false, reason: string}}
     */
    verifyLink({ purpose, token }) {
      if (!token) return { ok: false, reason: 'invalid' };
      const key = byLink.get(hashToken(token));
      const c = key ? byAttempt.get(key) : null;
      if (!c || c.purpose !== purpose) return { ok: false, reason: 'invalid' };
      if (c.expiresAt <= now()) { remove(key); return { ok: false, reason: 'expired' }; }
      remove(key);
      return { ok: true, challenge: { purpose: c.purpose, email: c.email, userId: c.userId } };
    },

    /** Number of live challenges — for tests and metrics, never for callers to branch on. */
    size() {
      prune();
      return byAttempt.size;
    },

    /**
     * Spend one unit of an address's send budget for an email that carries no code (the
     * "your account needs its password" notice). Same budget as codes, so neither kind can be
     * used to flood an inbox.
     * @returns {boolean} true when the email may be sent
     */
    allowSend(purpose, email) {
      prune();
      return underBudget(purpose, normalizeEmail(email));
    },

    /**
     * A response-shaped attempt that exists nowhere. For requests that must not be told
     * apart from a real one — an address outside the allowlist, or a password account asked
     * for a code — so the HTTP response cannot enumerate who has an account.
     */
    decoy(purpose) {
      return { attemptId: newToken(), expiresAt: now() + (ttl[purpose] ?? DEFAULT_TTL[purpose]) };
    }
  };
}
