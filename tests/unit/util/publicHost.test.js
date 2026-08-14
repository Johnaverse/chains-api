import { describe, it, expect } from 'vitest';
import { isPubliclyRoutable, safeExternalUrl } from '../../../src/util/publicHost.js';

describe('isPubliclyRoutable', () => {
  it('rejects every private IPv4 range', () => {
    // These are the addresses a crafted registry entry would aim at from inside the cluster.
    for (const host of [
      '10.43.0.1', '10.0.0.1',           // cluster services
      '127.0.0.1', '0.0.0.0',            // the pod itself
      '169.254.169.254',                 // cloud instance metadata
      '192.168.1.1',
      '172.16.0.1', '172.20.5.5', '172.31.255.254'
    ]) {
      expect(isPubliclyRoutable(host), host).toBe(false);
    }
  });

  it('does not over-block the 172.x space that IS public', () => {
    // Only 172.16–172.31 is private. 172.15 and 172.32 are ordinary internet addresses, and
    // a regex like /^172\./ would have silently dropped real explorers.
    expect(isPubliclyRoutable('172.15.0.1')).toBe(true);
    expect(isPubliclyRoutable('172.32.0.1')).toBe(true);
  });

  it('rejects internal names and bare hostnames', () => {
    for (const host of [
      'localhost', 'chains-api', 'litellm',
      'litellm.litellm.svc.cluster.local', 'db.svc', 'thing.internal', 'printer.local'
    ]) {
      expect(isPubliclyRoutable(host), host).toBe(false);
    }
  });

  it('rejects IPv6 loopback, link-local and unique-local', () => {
    for (const host of ['::1', '[::1]', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isPubliclyRoutable(host), host).toBe(false);
    }
  });

  it('accepts ordinary public hosts', () => {
    for (const host of ['eth.blockscout.com', 'gnosis.blockscout.com', 'rpc.ankr.com', '8.8.8.8']) {
      expect(isPubliclyRoutable(host), host).toBe(true);
    }
  });

  it('rejects nothing-at-all rather than throwing', () => {
    for (const host of [null, undefined, '', 42, {}]) {
      expect(isPubliclyRoutable(host)).toBe(false);
    }
  });
});

describe('safeExternalUrl', () => {
  it('accepts http and https to a public host', () => {
    expect(safeExternalUrl('https://eth.blockscout.com/api')?.hostname).toBe('eth.blockscout.com');
    expect(safeExternalUrl('http://eth.blockscout.com')?.hostname).toBe('eth.blockscout.com');
  });

  it('rejects other schemes', () => {
    // file: and gopher: are the classic SSRF escalations; ws: is simply not what these
    // callers speak.
    for (const url of ['file:///etc/passwd', 'gopher://x.com/', 'ws://eth.blockscout.com', 'ftp://x.com/']) {
      expect(safeExternalUrl(url), url).toBeNull();
    }
  });

  it('rejects a public-looking URL whose host is internal', () => {
    // The exact shape a malicious chains.json entry would take: it matches every
    // "blockscout" filter while pointing at a cluster address.
    expect(safeExternalUrl('http://10.43.0.1:8080/blockscout')).toBeNull();
    expect(safeExternalUrl('http://user@127.0.0.1/blockscout')).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const url of ['not a url', '', null, undefined, 'http://']) {
      expect(safeExternalUrl(url)).toBeNull();
    }
  });
});
