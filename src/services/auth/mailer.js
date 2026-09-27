import nodemailer from 'nodemailer';

/**
 * Outbound auth email over SMTP.
 *
 * Every sign-in email carries BOTH the magic link and the 6-digit code, and the code goes in
 * the subject line. That is a PWA decision, not decoration: someone signing in to the
 * installed app on a phone sees the code in the notification banner and types it without ever
 * leaving the app. The code is useless on its own — it only completes the attempt held by the
 * window that started it — so showing it on a lock screen gives nothing away.
 *
 * Nothing here logs a code, a token or a link. The only safe thing to log about an auth email
 * is that one was sent.
 */

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function minutesUntil(expiresAt, now) {
  return Math.max(1, Math.round((expiresAt - now) / 60000));
}

// Inline styles are correct here: mail clients strip <style> blocks and ignore external CSS.
// This HTML never reaches a browser under our CSP.
function layout({ heading, intro, code, link, linkLabel, footer }) {
  const codeBlock = code
    ? `<p style="font:600 32px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:6px;margin:24px 0;color:#111">${escapeHtml(code)}</p>`
    : '';
  const button = link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font:600 15px system-ui,sans-serif">${escapeHtml(linkLabel)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:32px;background:#f6f6f5;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:#222">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e4e4e0;border-radius:10px;padding:32px">
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(heading)}</h1>
<p style="margin:0">${escapeHtml(intro)}</p>
${codeBlock}${button}
<p style="margin:24px 0 0;color:#777;font-size:13px">${escapeHtml(footer)}</p>
</div></body></html>`;
}

/**
 * @param {object} options
 * @param {{sendMail: Function}} options.transport a nodemailer transport (injected in tests)
 * @param {string} options.from the From header, e.g. `Chains <no-reply@example.com>`
 * @param {string} [options.appName]
 * @param {() => number} [options.now]
 */
export function createMailer({ transport, from, appName = 'Chains', now = Date.now }) {
  async function send(to, subject, text, html) {
    await transport.sendMail({ from, to, subject, text, html });
  }

  return {
    /** The sign-in email: code for the app, link for the browser. */
    sendLoginCode({ to, code, link, expiresAt }) {
      const mins = minutesUntil(expiresAt, now());
      const intro = `Enter this code in the ${appName} window where you started signing in. It expires in ${mins} minutes.`;
      const footer = 'If you did not try to sign in, ignore this email. Nobody can sign in without it.';
      return send(
        to,
        `${appName} sign-in code: ${code}`,
        `Your ${appName} sign-in code is: ${code}\n\n${intro}\n\nOr sign in with this link:\n${link}\n\n${footer}\n`,
        layout({ heading: `Sign in to ${appName}`, intro, code, link, linkLabel: 'Sign in', footer })
      );
    },

    /**
     * Sent INSTEAD of a code when someone asks to sign in without a password for an account
     * that has one. The HTTP response is identical either way, so an outsider cannot learn
     * which accounts have passwords; only the inbox owner learns why no code arrived.
     */
    sendPasswordRequired({ to, appUrl }) {
      const intro = `Someone asked to sign in to ${appName} with an email code, but your account has a password. Sign in with your email and password instead.`;
      const footer = 'If this was not you, no action is needed. Your account is unchanged.';
      return send(
        to,
        `${appName}: sign in with your password`,
        `${intro}\n\n${appUrl}\n\n${footer}\n`,
        layout({ heading: 'Use your password to sign in', intro, link: appUrl, linkLabel: `Open ${appName}`, footer })
      );
    },

    sendResetCode({ to, code, link, expiresAt }) {
      const mins = minutesUntil(expiresAt, now());
      const intro = `Use this code, or the link below, to choose a new password. It expires in ${mins} minutes.`;
      const footer = 'If you did not ask to reset your password, ignore this email. Your password has not changed.';
      return send(
        to,
        `${appName} password reset code: ${code}`,
        `Your ${appName} password reset code is: ${code}\n\n${intro}\n\n${link}\n\n${footer}\n`,
        layout({ heading: 'Reset your password', intro, code, link, linkLabel: 'Choose a new password', footer })
      );
    },

    /**
     * After a password is set, changed or reset. A change the owner did not make is the one
     * signal they can act on, so it is sent unconditionally.
     */
    sendPasswordChanged({ to, appUrl }) {
      const intro = `The password for your ${appName} account was just changed, and every other signed-in session was signed out.`;
      const footer = 'If you did not do this, reset your password now from the sign-in page. Your email is still in your control.';
      return send(
        to,
        `${appName}: your password was changed`,
        `${intro}\n\n${appUrl}\n\n${footer}\n`,
        layout({ heading: 'Your password was changed', intro, link: appUrl, linkLabel: `Open ${appName}`, footer })
      );
    }
  };
}

/**
 * The real SMTP transport.
 *
 * STARTTLS is REQUIRED on a non-TLS port (`requireTLS`), so a server that does not offer it
 * fails the send instead of silently delivering sign-in codes in cleartext.
 *
 * @param {object} cfg
 * @param {string} cfg.host
 * @param {number} cfg.port
 * @param {boolean} cfg.secure true for implicit TLS (465), false for STARTTLS (587)
 * @param {string} [cfg.user]
 * @param {string} [cfg.pass]
 */
export function createSmtpTransport({ host, port, secure, user, pass }) {
  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  });
}
