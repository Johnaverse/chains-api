import { describe, it, expect } from 'vitest';
import { clientKey } from '../../../src/http/clientKey.js';

describe('clientKey', () => {
  it('keys on the visitor address Cloudflare forwards, else the TCP peer', () => {
    expect(clientKey({ 'cf-connecting-ip': '203.0.113.7' }, '10.42.0.9')).toBe('203.0.113.7');
    expect(clientKey({ 'cf-connecting-ip': '2001:db8::1' }, '10.42.0.9')).toBe('2001:db8::1');
    // Not an address (garbage, a list): the gateway peer, never the raw header text.
    expect(clientKey({ 'cf-connecting-ip': 'evil, 1.2.3.4' }, '10.42.0.9')).toBe('10.42.0.9');
    expect(clientKey({}, '10.42.0.9')).toBe('10.42.0.9');
    expect(clientKey({}, undefined)).toBe('unknown');
  });
});

describe('RATE_LIMIT_CLIENT_IP_HEADER', () => {
  it('set empty turns the header off rather than falling back to the default', async () => {
    const before = process.env.RATE_LIMIT_CLIENT_IP_HEADER;
    process.env.RATE_LIMIT_CLIENT_IP_HEADER = '';
    try {
      const { vi } = await import('vitest');
      vi.resetModules();
      const { clientKey: fresh } = await import('../../../src/http/clientKey.js');
      expect(fresh({ 'cf-connecting-ip': '203.0.113.7' }, '10.42.0.9')).toBe('10.42.0.9');
    } finally {
      if (before === undefined) delete process.env.RATE_LIMIT_CLIENT_IP_HEADER;
      else process.env.RATE_LIMIT_CLIENT_IP_HEADER = before;
    }
  });
});
