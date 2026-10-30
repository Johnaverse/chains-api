import { describe, it, expect } from 'vitest';
import { withBase } from '../../../src/http/appShell.js';

describe('withBase', () => {
  it('adds a <base> at the top of <head>, with a trailing slash', () => {
    expect(withBase('<html><head><title>x</title></head></html>', '/chains-api'))
      .toBe('<html><head>\n    <base href="/chains-api/"><title>x</title></head></html>');
    expect(withBase('<head></head>', '/ui/')).toContain('<base href="/ui/">');
  });

  it('refuses a base that is not a plain path', () => {
    expect(() => withBase('<head></head>', '/x"><script>')).toThrow();
    expect(() => withBase('<head></head>', 'https://evil.example/')).toThrow();
  });
});
