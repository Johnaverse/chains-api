import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('fetchUtil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('proxyFetch without proxy', () => {
    it('should use standard fetch when proxy is disabled', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      vi.doMock('../../config.js', () => ({
        PROXY_URL: '',
        PROXY_ENABLED: false,
      }));
      vi.doMock('https-proxy-agent', () => ({
        HttpsProxyAgent: vi.fn(),
      }));

      const { proxyFetch } = await import('../../fetchUtil.js');
      await proxyFetch('https://example.com/api');

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/api', {});
    });

    it('should pass options to standard fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      vi.doMock('../../config.js', () => ({
        PROXY_URL: '',
        PROXY_ENABLED: false,
      }));
      vi.doMock('https-proxy-agent', () => ({
        HttpsProxyAgent: vi.fn(),
      }));

      const { proxyFetch } = await import('../../fetchUtil.js');
      await proxyFetch('https://example.com/api', { method: 'POST' });

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/api', { method: 'POST' });
    });
  });

  describe('getProxyStatus', () => {
    it('should return disabled status when proxy is not configured', async () => {
      vi.doMock('../../config.js', () => ({
        PROXY_URL: '',
        PROXY_ENABLED: false,
      }));
      vi.doMock('https-proxy-agent', () => ({
        HttpsProxyAgent: vi.fn(),
      }));

      const { getProxyStatus } = await import('../../fetchUtil.js');
      const status = getProxyStatus();

      expect(status.enabled).toBe(false);
      expect(status.url).toBeNull();
    });

    it('should return enabled status with masked URL when proxy configured', async () => {
      vi.doMock('../../config.js', () => ({
        PROXY_URL: 'http://user:password@proxy.example.com:8080',
        PROXY_ENABLED: true,
      }));
      vi.doMock('https-proxy-agent', () => ({
        HttpsProxyAgent: vi.fn(() => ({})),
      }));

      const { getProxyStatus } = await import('../../fetchUtil.js');
      const status = getProxyStatus();

      expect(status.enabled).toBe(true);
      expect(status.url).not.toContain('password');
    });
  });

  describe('proxy initialization error handling', () => {
    it('should handle proxy agent initialization failure gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      vi.doMock('../../config.js', () => ({
        PROXY_URL: 'invalid-url',
        PROXY_ENABLED: true,
      }));
      vi.doMock('https-proxy-agent', () => ({
        HttpsProxyAgent: vi.fn(() => { throw new Error('Invalid proxy URL'); }),
      }));

      const { proxyFetch } = await import('../../fetchUtil.js');

      // Should fall back to standard fetch since proxy init failed
      await proxyFetch('https://example.com/api');
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/api', {});

      consoleErrorSpy.mockRestore();
    });
  });
});
