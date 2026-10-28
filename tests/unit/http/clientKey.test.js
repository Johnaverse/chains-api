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
