import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Proxy Support', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe('fetchUtil', () => {
    it('should export proxyFetch and getProxyStatus functions', async () => {
      // Mock config with proxy disabled
      vi.doMock('../../config.js', () => ({
        PROXY_URL: '',
        PROXY_ENABLED: false
      }));

      const { proxyFetch, getProxyStatus } = await import('../../fetchUtil.js');
      
      expect(proxyFetch).toBeDefined();
      expect(typeof proxyFetch).toBe('function');
      expect(getProxyStatus).toBeDefined();
      expect(typeof getProxyStatus).toBe('function');
    });

    it('should return disabled status when proxy is not configured', async () => {
      vi.doMock('../../config.js', () => ({
        PROXY_URL: '',
        PROXY_ENABLED: false
      }));

      const { getProxyStatus } = await import('../../fetchUtil.js');
      const status = getProxyStatus();
      
      expect(status.enabled).toBe(false);
      expect(status.url).toBeNull();
    });

    it('should return enabled status when proxy is configured', async () => {
      vi.doMock('../../config.js', () => ({
        PROXY_URL: 'http://proxy.example.com:8080',
        PROXY_ENABLED: true
      }));

      const { getProxyStatus } = await import('../../fetchUtil.js');
      const status = getProxyStatus();
      
      expect(status.enabled).toBe(true);
      expect(status.url).toBe('http://proxy.example.com:8080');
    });

    it('should hide password in proxy URL when returning status', async () => {
      vi.doMock('../../config.js', () => ({
        PROXY_URL: 'http://user:password@proxy.example.com:8080',
        PROXY_ENABLED: true
      }));

      const { getProxyStatus } = await import('../../fetchUtil.js');
      const status = getProxyStatus();
      
      expect(status.enabled).toBe(true);
      expect(status.url).toBe('http://user:****@proxy.example.com:8080');
      expect(status.url).not.toContain('password');
    });

    it('should use standard fetch when proxy is disabled', async () => {
      vi.doMock('../../config.js', () => ({
        PROXY_URL: '',
        PROXY_ENABLED: false
      }));

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ test: 'data' })
      });

      const { proxyFetch } = await import('../../fetchUtil.js');
      
      await proxyFetch('https://example.com/api', { method: 'GET' });
      
      expect(global.fetch).toHaveBeenCalledWith('https://example.com/api', { method: 'GET' });
    });

    it('should handle proxy configuration errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      vi.doMock('../../config.js', () => ({
        PROXY_URL: 'invalid-url',
        PROXY_ENABLED: true
      }));

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ test: 'data' })
      });

      const { proxyFetch } = await import('../../fetchUtil.js');
      
      // Should fall back to standard fetch if proxy initialization fails
      const result = await proxyFetch('https://example.com/api');
      
      expect(result).toBeDefined();
      expect(global.fetch).toHaveBeenCalled();
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Config', () => {
    it('should export PROXY_URL and PROXY_ENABLED', async () => {
      const config = await import('../../config.js');
      
      expect(config).toHaveProperty('PROXY_URL');
      expect(config).toHaveProperty('PROXY_ENABLED');
    });
  });
});
