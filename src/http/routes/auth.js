import { AUTH_RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../../../config.js';
import { getAuth, isValidEmail } from '../../services/auth/index.js';
import { PURPOSES } from '../../services/auth/challenges.js';
import { normalizeEmail } from '../../services/auth/store.js';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  passwordPolicyError
} from '../../services/auth/password.js';
import {
  sessionCookie,
  clearSessionCookie,
  readSession,
  publicUser
} from '../../services/auth/session.js';
import { sendError } from '../util/sendError.js';

/**
 * Accounts: email sign-in in the style of Claude's, an optional salted password, and reset.
 *
 * SIGNING IN. You give your email — and your password, if your account has one. We email a
 * magic link AND a 6-digit code; either finishes the sign-in. So every sign-in ends with proof
 * that you hold the inbox, and an account with a password needs both: a stolen password alone
 * gets an attacker a code sent to somebody else's inbox.
 *
 * THE PWA. An installed app is its own browser context, and on iOS a tapped link opens in the
 * system browser, not the app. So the code is a first-class path, not a fallback: the app
 * shows the code field at once, the code rides in the email subject so it is readable from
 * the notification, and it is bound to the attempt only this window holds. The link still
 * works — and where the platform captures links into the installed app (the manifest asks
 * for that), it opens right there.
 *
 * WHAT NOBODY OUTSIDE CAN LEARN. Whether an address has an account, is on the allowlist, has
 * a password, or has asked for too many codes. Every "send me a code" request gets the same
 * 202 and the same body, email delivery never delays the response (so timing cannot tell
 * them apart either), and every failed code, link or password gets one generic message.
 *
 * Closed by default: when auth is not configured this plugin registers nothing, so every
 * /auth path is a plain 404 — SERVICE-CONTRACT §10's posture for anything that sends mail.
 */

const MSG_CHALLENGE_FAILED = 'That code or link is invalid or has expired. Request a new one.';
const MSG_BAD_CREDENTIALS = 'Incorrect email or password.';

const rateLimited = { rateLimit: { max: AUTH_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW_MS } };

const email = {
  type: 'string',
  maxLength: 254,
  errorMessage: { maxLength: 'Field "email" too long. Max length: 254' }
};
// Byte ceilings on the wire; passwordPolicyError enforces the real limits in characters.
const password = { type: 'string', maxLength: 1024 };
const opaque = { type: 'string', minLength: 1, maxLength: 128 };
const code = { type: 'string', minLength: 1, maxLength: 16 };

function body(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

/**
 * CSRF, the other half (SameSite=Lax is the first). A browser always sends Origin on a
 * cross-origin POST; one from a page we do not trust is refused. A request with no Origin is a
 * non-browser client — curl, a script — and CSRF is not a risk there, since it has no victim
 * cookie jar to ride on.
 */
function originAllowed(request, auth) {
  const origin = request.headers.origin;
  if (!origin) return request.headers['sec-fetch-site'] !== 'cross-site';
  if (auth.origins.has(origin)) return true;
  try {
    // Parse the Host through the same scheme so default ports compare equal on both sides:
    // URL('http://h:80').host is 'h', while a Host header may still say 'h:80'.
    const o = new URL(origin);
    return new URL(`${o.protocol}//${request.headers.host}`).host === o.host;
  } catch {
    return false;
  }
}

export async function authRoutes(fastify, opts = {}) {
  const auth = opts.auth ?? getAuth();
  if (!auth.enabled) return;

  const { store, challenges, mailer } = auth;

  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET' && !originAllowed(request, auth)) {
      return sendError(reply, 403, 'Cross-origin request refused');
    }
  });

  // Sent after the response, never awaited by it: a request that ends in "email sent" must
  // take as long as one that ends in "nothing sent", or the latency itself enumerates
  // accounts. Failures are logged without the address or any secret.
  function dispatch(kind, send) {
    Promise.resolve()
      .then(send)
      .catch((err) => fastify.log.error({ err: err.message, kind }, 'Auth email delivery failed'));
  }

  const accepted = (reply, { attemptId, expiresAt }) =>
    reply.code(202).send({ attemptId, expiresAt: new Date(expiresAt).toISOString(), next: 'code' });

  async function signIn(reply, user) {
    await store.recordLogin(user.id);
    const { token } = await store.createSession(user.id, auth.sessionTtlMs);
    reply.header('set-cookie', sessionCookie(token, { ttlMs: auth.sessionTtlMs, secure: auth.cookieSecure }));
    return { authenticated: true, user: publicUser(await store.getUser(user.id)) };
  }

  async function finishLogin(reply, result) {
    // Re-checked at the finish, not only at the start: an address removed from the allowlist
    // while its code was in flight must not complete.
    if (!result.ok || !auth.isAllowed(result.challenge.email)) {
      return sendError(reply, 400, MSG_CHALLENGE_FAILED);
    }
    const user = (await store.findUserByEmail(result.challenge.email)) ?? (await store.createUser(result.challenge.email));
    return signIn(reply, user);
  }

  // ── Sign in ─────────────────────────────────────────────────────────────

  fastify.post('/auth/login/start', {
    config: rateLimited,
    schema: {
      description: 'Start signing in. Always answers 202 for an email-only request — whether or not the address has an account — and emails a magic link plus a 6-digit code. An account with a password must include it; a wrong password is a 401.',
      body: body({ email, password }, ['email'])
    }
  }, async (request, reply) => {
    const { email: address, password: pw } = request.body;
    if (!isValidEmail(address)) return sendError(reply, 400, 'Enter a valid email address.');

    const allowed = auth.isAllowed(address);
    const user = allowed ? await store.findUserByEmail(address) : null;

    if (typeof pw === 'string' && pw.length > 0) {
      // verifyPassword always performs a full scrypt derivation, including for a missing
      // account or one without a password, so this branch costs the same time whoever asks.
      const ok = await verifyPassword(pw, user?.passwordHash);
      if (!allowed || !user || !ok) return sendError(reply, 401, MSG_BAD_CREDENTIALS);

      if (needsRehash(user.passwordHash)) {
        await store.setPasswordHash(user.id, await hashPassword(pw));
      }
      const c = challenges.issue({ purpose: PURPOSES.LOGIN, email: address, userId: user.id });
      if (c.deliver) {
        dispatch('login', () => mailer.sendLoginCode({ to: user.email, code: c.code, link: auth.loginLink(c.linkToken), expiresAt: c.expiresAt }));
      }
      return accepted(reply, c);
    }

    if (!allowed) return accepted(reply, challenges.decoy(PURPOSES.LOGIN));

    if (user?.passwordHash) {
      // Same 202 as everyone else; only the inbox owner learns why no code came.
      if (challenges.allowSend(PURPOSES.LOGIN, address)) {
        dispatch('password-required', () => mailer.sendPasswordRequired({ to: user.email, appUrl: auth.loginPageUrl }));
      }
      return accepted(reply, challenges.decoy(PURPOSES.LOGIN));
    }

    const c = challenges.issue({ purpose: PURPOSES.LOGIN, email: address, userId: user?.id ?? null });
    if (c.deliver) {
      // The normalized address, never the raw input: " Owner@X.io " is the same account, and
      // mail must go where the account says, not wherever the form's casing and spaces point.
      const to = normalizeEmail(address);
      dispatch('login', () => mailer.sendLoginCode({ to, code: c.code, link: auth.loginLink(c.linkToken), expiresAt: c.expiresAt }));
    }
    return accepted(reply, c);
  });

  fastify.post('/auth/login/verify', {
    config: rateLimited,
    schema: {
      description: 'Finish signing in with the 6-digit code. Needs the attemptId from /auth/login/start, which only the window that started the attempt holds. Sets the session cookie.',
      body: body({ attemptId: opaque, code }, ['attemptId', 'code'])
    }
  }, async (request, reply) => finishLogin(reply, challenges.verifyCode({ purpose: PURPOSES.LOGIN, ...request.body })));

  fastify.post('/auth/login/link', {
    config: rateLimited,
    schema: {
      description: 'Finish signing in with the magic-link token. Called by the sign-in page after the user confirms — never on page load, so mail scanners that prefetch links cannot spend it. Signs in the browser that makes the call.',
      body: body({ token: opaque }, ['token'])
    }
  }, async (request, reply) => finishLogin(reply, challenges.verifyLink({ purpose: PURPOSES.LOGIN, token: request.body.token })));

  // ── Session ─────────────────────────────────────────────────────────────

  fastify.get('/auth/session', {
    schema: { description: 'Who is signed in. Always 200, with `authenticated: false` when nobody is, so a page can branch without an error.' }
  }, async (request) => {
    const s = await readSession(request, auth);
    return s ? { authenticated: true, user: publicUser(s.user) } : { authenticated: false };
  });

  fastify.post('/auth/logout', {
    schema: { description: 'Sign out this browser.' }
  }, async (request, reply) => {
    const s = await readSession(request, auth);
    if (s) await store.revokeSession(s.token);
    reply.header('set-cookie', clearSessionCookie({ secure: auth.cookieSecure }));
    return reply.code(204).send();
  });

  // ── Password ────────────────────────────────────────────────────────────

  fastify.post('/auth/password', {
    config: rateLimited,
    schema: {
      description: 'Set a password (first time) or change it (currentPassword required). Signs out every other session and emails a notice.',
      body: body({ currentPassword: password, newPassword: password }, ['newPassword'])
    }
  }, async (request, reply) => {
    const s = await readSession(request, auth);
    if (!s) return sendError(reply, 401, 'Sign in first.');

    const policy = passwordPolicyError(request.body.newPassword);
    if (policy) return sendError(reply, 400, policy);

    if (s.user.passwordHash) {
      const ok = await verifyPassword(request.body.currentPassword ?? '', s.user.passwordHash);
      if (!ok) return sendError(reply, 401, 'Current password is incorrect.');
    }

    await store.setPasswordHash(s.user.id, await hashPassword(request.body.newPassword));
    await store.revokeAllSessions(s.user.id, { exceptToken: s.token });
    dispatch('password-changed', () => mailer.sendPasswordChanged({ to: s.user.email, appUrl: auth.loginPageUrl }));
    return { ok: true, user: publicUser(await store.getUser(s.user.id)) };
  });

  fastify.post('/auth/password/reset/start', {
    config: rateLimited,
    schema: {
      description: 'Email a password-reset link and code. Always answers 202, whether or not the address has an account.',
      body: body({ email }, ['email'])
    }
  }, async (request, reply) => {
    const address = request.body.email;
    if (!isValidEmail(address)) return sendError(reply, 400, 'Enter a valid email address.');

    const user = auth.isAllowed(address) ? await store.findUserByEmail(address) : null;
    if (!user) return accepted(reply, challenges.decoy(PURPOSES.RESET));

    const c = challenges.issue({ purpose: PURPOSES.RESET, email: address, userId: user.id });
    if (c.deliver) {
      dispatch('reset', () => mailer.sendResetCode({ to: user.email, code: c.code, link: auth.resetLink(c.linkToken), expiresAt: c.expiresAt }));
    }
    return accepted(reply, c);
  });

  fastify.post('/auth/password/reset/complete', {
    config: rateLimited,
    schema: {
      description: 'Choose a new password with the reset code (plus attemptId) or the reset-link token. Signs out every session, emails a notice, and signs in this browser.',
      body: body({ attemptId: opaque, code, token: opaque, newPassword: password }, ['newPassword'])
    }
  }, async (request, reply) => {
    const { attemptId, code: typed, token, newPassword } = request.body;

    // Before the challenge is touched: a password that fails policy must not burn the code,
    // or a typo in the new password would force the user to request another email.
    const policy = passwordPolicyError(newPassword);
    if (policy) return sendError(reply, 400, policy);

    const result = token
      ? challenges.verifyLink({ purpose: PURPOSES.RESET, token })
      : challenges.verifyCode({ purpose: PURPOSES.RESET, attemptId, code: typed });
    if (!result.ok || !auth.isAllowed(result.challenge.email)) return sendError(reply, 400, MSG_CHALLENGE_FAILED);

    const user = await store.findUserByEmail(result.challenge.email);
    if (!user) return sendError(reply, 400, MSG_CHALLENGE_FAILED);

    await store.setPasswordHash(user.id, await hashPassword(newPassword));
    // A reset is what someone does when they think the account is compromised, so every
    // existing session goes — including any an attacker holds.
    await store.revokeAllSessions(user.id);
    dispatch('password-changed', () => mailer.sendPasswordChanged({ to: user.email, appUrl: auth.loginPageUrl }));
    return signIn(reply, user);
  });
}
