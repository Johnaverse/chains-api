import { describe, it, expect, vi } from 'vitest';
import { createMailer, createSmtpTransport } from '../../../../src/services/auth/mailer.js';

const NOW = Date.parse('2026-09-27T00:00:00Z');

function mailerWithSpy() {
  const transport = { sendMail: vi.fn().mockResolvedValue({}) };
  const mailer = createMailer({ transport, from: 'Chains <no-reply@x.io>', now: () => NOW });
  return { mailer, sent: () => transport.sendMail.mock.calls.map((c) => c[0]), transport };
}

describe('auth mailer', () => {
  it('puts the code in the subject, so it is readable from a phone notification', async () => {
    const { mailer, sent } = mailerWithSpy();
    await mailer.sendLoginCode({ to: 'a@x.io', code: '482193', link: 'https://app/login.html#verify=t', expiresAt: NOW + 10 * 60000 });
    const [msg] = sent();
    expect(msg.subject).toBe('Chains sign-in code: 482193');
    expect(msg.to).toBe('a@x.io');
    expect(msg.from).toBe('Chains <no-reply@x.io>');
  });

  it('carries BOTH the code and the link, in text and in HTML', async () => {
    const { mailer, sent } = mailerWithSpy();
    const link = 'https://app/login.html#verify=abc';
    await mailer.sendLoginCode({ to: 'a@x.io', code: '482193', link, expiresAt: NOW + 10 * 60000 });
    const [msg] = sent();
    for (const body of [msg.text, msg.html]) {
      expect(body).toContain('482193');
      expect(body).toContain(link);
    }
    expect(msg.text).toContain('expires in 10 minutes');
  });

  it('escapes HTML in everything it interpolates', async () => {
    const { mailer, sent } = mailerWithSpy();
    await mailer.sendLoginCode({ to: 'a@x.io', code: '<b>1</b>', link: 'https://app/"><script>', expiresAt: NOW + 60000 });
    const [msg] = sent();
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).not.toContain('<b>1</b>');
    expect(msg.html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });

  it('sends a no-code notice to password accounts, which says why no code came', async () => {
    const { mailer, sent } = mailerWithSpy();
    await mailer.sendPasswordRequired({ to: 'a@x.io', appUrl: 'https://app/login.html' });
    const [msg] = sent();
    expect(msg.subject).toMatch(/password/);
    expect(msg.text).not.toMatch(/\b\d{6}\b/);
  });

  it('sends reset codes with their own subject', async () => {
    const { mailer, sent } = mailerWithSpy();
    await mailer.sendResetCode({ to: 'a@x.io', code: '111222', link: 'https://app/login.html#reset=t', expiresAt: NOW + 30 * 60000 });
    const [msg] = sent();
    expect(msg.subject).toBe('Chains password reset code: 111222');
    expect(msg.text).toContain('expires in 30 minutes');
  });

  it('notifies after a password change', async () => {
    const { mailer, sent } = mailerWithSpy();
    await mailer.sendPasswordChanged({ to: 'a@x.io', appUrl: 'https://app/login.html' });
    expect(sent()[0].subject).toMatch(/password was changed/);
  });

  it('never claims less than one minute remaining', async () => {
    const { mailer, sent } = mailerWithSpy();
    await mailer.sendLoginCode({ to: 'a@x.io', code: '000001', link: 'https://l', expiresAt: NOW - 5000 });
    expect(sent()[0].text).toContain('expires in 1 minutes');
  });

  it('propagates a delivery failure so the caller can decide what to tell the user', async () => {
    const transport = { sendMail: vi.fn().mockRejectedValue(new Error('SMTP down')) };
    const mailer = createMailer({ transport, from: 'x@x.io' });
    await expect(mailer.sendLoginCode({ to: 'a@x.io', code: '1', link: 'l', expiresAt: Date.now() })).rejects.toThrow('SMTP down');
  });
});

describe('createSmtpTransport', () => {
  it('requires STARTTLS on a non-TLS port, so codes are never sent in cleartext', () => {
    const t = createSmtpTransport({ host: 'smtp.x.io', port: 587, secure: false, user: 'u', pass: 'p' });
    expect(t.options.requireTLS).toBe(true);
    expect(t.options.secure).toBe(false);
    expect(t.options.auth).toEqual({ user: 'u', pass: 'p' });
  });

  it('uses implicit TLS on 465 and omits auth when no user is configured', () => {
    const t = createSmtpTransport({ host: 'smtp.x.io', port: 465, secure: true });
    expect(t.options.secure).toBe(true);
    expect(t.options.auth).toBeUndefined();
  });
});
