import { describe, it, expect } from 'vitest';
import {
  parseAllowlist,
  isAllowedEmail,
  isValidEmail,
  allowedOrigins,
  createAuth,
  authConfigProblems,
  getAuth,
  _setAuthForTests
} from '../../../../src/services/auth/index.js';

describe('allowlist', () => {
  const list = parseAllowlist(' Owner@X.io , @Team.io,, ');

  it('parses exact addresses and whole domains, case-insensitively', () => {
    expect([...list.emails]).toEqual(['owner@x.io']);
    expect(list.domains).toEqual(['@team.io']);
  });

  it('allows listed addresses and domain members', () => {
    expect(isAllowedEmail('OWNER@x.io', list)).toBe(true);
    expect(isAllowedEmail('anyone@team.io', list)).toBe(true);
  });

  it('refuses lookalike domains, subdomains and the bare domain', () => {
    expect(isAllowedEmail('eve@evilteam.io', list)).toBe(false);
    expect(isAllowedEmail('eve@sub.team.io', list)).toBe(false);
    expect(isAllowedEmail('@team.io', list)).toBe(false);
    expect(isAllowedEmail('', list)).toBe(false);
  });

  it('an empty allowlist allows nobody', () => {
    expect(isAllowedEmail('owner@x.io', parseAllowlist(''))).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('accepts ordinary addresses, including plus-addressing', () => {
    for (const e of ['a@x.io', 'first.last+tag@sub.example.co.uk', ' Mixed@Case.IO ']) expect(isValidEmail(e), e).toBe(true);
  });

  it('refuses every shape mail parsers have historically mishandled', () => {
    const hostile = [
      'x@y.io, z@w.io',        // address list
      'Name <x@y.io>',         // display name
      '"quoted"@x.io',         // quoted local part
      'x@y.io (comment)',      // RFC 5322 comment
      'x@y.io\r\nBcc: z@w.io', // header injection
      'a b@x.io', 'a@b', 'a@@x.io', '.a@x.io', 'a.@x.io', 'a..b@x.io',
      `${'a'.repeat(65)}@x.io`, `a@${'b'.repeat(250)}.io`, 42, null
    ];
    for (const e of hostile) expect(isValidEmail(e), String(e)).toBe(false);
  });
});

describe('allowedOrigins', () => {
  it('takes the origin of the app URL plus any extras, ignoring junk', () => {
    const o = allowedOrigins('https://www.x.io/chains-api/', 'https://alt.x.io/, not a url, ');
    expect([...o].sort()).toEqual(['https://alt.x.io', 'https://www.x.io']);
  });
});

describe('createAuth', () => {
  it('builds links on the dashboard, with the token in the fragment', () => {
    const a = createAuth({ enabled: true, allowlist: parseAllowlist(''), appUrl: 'https://www.x.io/chains-api', origins: new Set() });
    expect(a.loginPageUrl).toBe('https://www.x.io/chains-api/login.html');
    expect(a.loginLink('T')).toBe('https://www.x.io/chains-api/login.html#verify=T');
    expect(a.resetLink('T')).toBe('https://www.x.io/chains-api/login.html#reset=T');
  });
});

describe('authConfigProblems', () => {
  const all = { AUTH_ALLOWED_EMAILS: 'a@x.io', AUTH_APP_URL: 'https://www.x.io/', SMTP_HOST: 'smtp.x.io' };

  it('is silent when auth is deliberately off or fully on', () => {
    expect(authConfigProblems({ AUTH_ALLOWED_EMAILS: '', AUTH_APP_URL: '', SMTP_HOST: '' })).toEqual([]);
    expect(authConfigProblems(all)).toEqual([]);
  });

  it('names exactly what is missing when half-configured', () => {
    const [p] = authConfigProblems({ ...all, SMTP_HOST: '' });
    expect(p).toMatch(/SMTP_HOST/);
    expect(p).not.toMatch(/AUTH_APP_URL/);
  });

  it('flags an app URL that is invalid, or not https outside localhost', () => {
    expect(authConfigProblems({ ...all, AUTH_APP_URL: 'nope' }).join()).toMatch(/not a valid URL/);
    expect(authConfigProblems({ ...all, AUTH_APP_URL: 'http://www.x.io/' }).join()).toMatch(/not https/);
    expect(authConfigProblems({ ...all, AUTH_APP_URL: 'http://localhost:3000/ui/' })).toEqual([]);
  });
});

describe('getAuth', () => {
  it('is disabled with no config, and can be swapped for tests', () => {
    _setAuthForTests(null);
    expect(getAuth().enabled).toBe(false);
    const fake = { enabled: true };
    _setAuthForTests(fake);
    expect(getAuth()).toBe(fake);
    _setAuthForTests(null);
  });
});
