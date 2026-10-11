import { describe, it, expect, beforeEach } from 'vitest';
import { createChallengeService, PURPOSES } from '../../../../src/services/auth/challenges.js';

const MIN = 60 * 1000;

describe('email challenges', () => {
  let clock;
  let svc;
  beforeEach(() => {
    clock = Date.parse('2026-09-27T00:00:00Z');
    svc = createChallengeService({ now: () => clock });
  });

  const open = (email = 'a@x.io', purpose = PURPOSES.LOGIN) => svc.issue({ purpose, email, userId: 'u1' });

  describe('issuing', () => {
    it('produces a 6-digit code, an opaque attempt id and link token, and a deadline', () => {
      const c = open();
      expect(c.code).toMatch(/^\d{6}$/);
      expect(c.attemptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(c.linkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(c.attemptId).not.toBe(c.linkToken);
      expect(c.expiresAt).toBe(clock + 10 * MIN);
      expect(c.deliver).toBe(true);
    });

    it('gives reset challenges a longer life than login ones', () => {
      expect(open('a@x.io', PURPOSES.RESET).expiresAt).toBe(clock + 30 * MIN);
    });

    it('rejects an unknown purpose', () => {
      expect(() => svc.issue({ purpose: 'admin', email: 'a@x.io' })).toThrow(/Unknown purpose/);
    });
  });

  describe('finishing with the code (the PWA path)', () => {
    it('accepts the right code once, then never again', () => {
      const c = open();
      const ok = svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code });
      expect(ok).toMatchObject({ ok: true, challenge: { email: 'a@x.io', userId: 'u1' } });
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code }).ok).toBe(false);
    });

    it('tolerates the spaces and dashes people type when copying a code', () => {
      const c = open();
      const spaced = `${c.code.slice(0, 3)} ${c.code.slice(3)}`;
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: spaced }).ok).toBe(true);
    });

    it('needs the attempt id — the right code without it is worthless', () => {
      const c = open();
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: 'someone-elses-attempt', code: c.code }).ok).toBe(false);
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: undefined, code: c.code }).ok).toBe(false);
    });

    it('locks the challenge after five wrong guesses, even against the right code afterwards', () => {
      const c = open();
      const wrong = c.code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i++) {
        expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: wrong }).reason).toBe('invalid');
      }
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: wrong }).reason).toBe('locked');
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code }).ok).toBe(false);
    });

    it('expires at its deadline', () => {
      const c = open();
      clock += 10 * MIN;
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code }).reason).toBe('expired');
    });

    it('rejects malformed input without counting it as a guess', () => {
      const c = open();
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: 123456 }).ok).toBe(false);
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code }).ok).toBe(true);
    });
  });

  describe('finishing with the magic link', () => {
    it('accepts the link once', () => {
      const c = open();
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: c.linkToken }).ok).toBe(true);
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: c.linkToken }).ok).toBe(false);
    });

    it('rejects an unknown or missing token', () => {
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: 'forged' }).ok).toBe(false);
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: '' }).ok).toBe(false);
    });

    it('expires at its deadline', () => {
      const c = open();
      clock += 10 * MIN;
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: c.linkToken }).reason).toBe('expired');
    });
  });

  describe('one challenge, two ways to finish it', () => {
    it('using the link consumes the code', () => {
      const c = open();
      svc.verifyLink({ purpose: PURPOSES.LOGIN, token: c.linkToken });
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code }).ok).toBe(false);
    });

    it('using the code consumes the link', () => {
      const c = open();
      svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: c.attemptId, code: c.code });
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: c.linkToken }).ok).toBe(false);
    });
  });

  describe('purpose isolation', () => {
    it('a login code cannot complete a password reset, and vice versa', () => {
      const login = open('a@x.io', PURPOSES.LOGIN);
      const reset = open('a@x.io', PURPOSES.RESET);
      expect(svc.verifyCode({ purpose: PURPOSES.RESET, attemptId: login.attemptId, code: login.code }).ok).toBe(false);
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: reset.linkToken }).ok).toBe(false);
      // …and each still works for its own purpose.
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: login.attemptId, code: login.code }).ok).toBe(true);
      expect(svc.verifyLink({ purpose: PURPOSES.RESET, token: reset.linkToken }).ok).toBe(true);
    });
  });

  describe('resend', () => {
    it('a new request supersedes the previous one for the same address', () => {
      const first = open();
      const second = open();
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: first.attemptId, code: first.code }).ok).toBe(false);
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: second.attemptId, code: second.code }).ok).toBe(true);
    });

    it('does not disturb another address\'s challenge', () => {
      const a = open('a@x.io');
      open('b@x.io');
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: a.attemptId, code: a.code }).ok).toBe(true);
    });
  });

  describe('send budget', () => {
    it('stops delivering after five sends an hour, with an attempt that cannot succeed', () => {
      for (let i = 0; i < 5; i++) expect(open().deliver).toBe(true);
      const over = open();
      expect(over.deliver).toBe(false);
      // Well-formed, so the response looks identical — but nothing verifies.
      expect(over.code).toMatch(/^\d{6}$/);
      expect(svc.verifyCode({ purpose: PURPOSES.LOGIN, attemptId: over.attemptId, code: over.code }).ok).toBe(false);
      expect(svc.verifyLink({ purpose: PURPOSES.LOGIN, token: over.linkToken }).ok).toBe(false);
    });

    it('recovers once the hour has passed', () => {
      for (let i = 0; i < 5; i++) open();
      expect(open().deliver).toBe(false);
      clock += 61 * MIN;
      expect(open().deliver).toBe(true);
    });

    it('budgets each address separately', () => {
      for (let i = 0; i < 5; i++) open('a@x.io');
      expect(open('b@x.io').deliver).toBe(true);
    });
  });

  it('forgets expired challenges', () => {
    open('a@x.io');
    open('b@x.io');
    expect(svc.size()).toBe(2);
    clock += 11 * MIN;
    expect(svc.size()).toBe(0);
  });
});
