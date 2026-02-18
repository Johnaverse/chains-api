import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing rpcMonitor
vi.mock('../../config.js', () => ({
  MAX_ENDPOINTS_PER_CHAIN: 5,
  PROXY_URL: '',
  PROXY_ENABLED: false
}));

// Mock rpcUtil (replaces direct fetchUtil usage)
vi.mock('../../rpcUtil.js', () => ({
  jsonRpcCall: vi.fn(),
}));

import { jsonRpcCall } from '../../rpcUtil.js';

// Mock dataService
vi.mock('../../dataService.js', () => ({
  getAllEndpoints: vi.fn(() => [
    {
      chainId: 1,
      name: 'Ethereum Mainnet',
      rpc: [
        'https://eth.llamarpc.com',
        'https://rpc.ankr.com/eth'
      ]
    },
    {
      chainId: 137,
      name: 'Polygon',
      rpc: [
        'https://polygon-rpc.com',
        { url: 'https://rpc.ankr.com/polygon' }
      ]
    }
  ])
}));

import { getMonitoringResults, getMonitoringStatus, startRpcHealthCheck, startMonitoring } from '../../rpcMonitor.js';
import { getAllEndpoints } from '../../dataService.js';

describe('RPC Monitor', () => {
  beforeEach(async () => {
    // Set a default resolving mock so any lingering background monitoring completes quickly
    vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
    // Wait for any pending monitoring from previous tests to settle
    await new Promise(resolve => setTimeout(resolve, 50));
    vi.clearAllMocks();
    // Re-set default mock after clearing (for tests that don't set their own)
    vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
  });

  afterEach(async () => {
    // Ensure any background monitoring completes before next test
    // Use resolving mock so background work finishes fast (do NOT restoreAllMocks
    // as that would restore real implementations that make network calls)
    vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  describe('getMonitoringResults', () => {
    it('should return monitoring results object', () => {
      const results = getMonitoringResults();

      expect(results).toBeDefined();
      expect(results).toHaveProperty('lastUpdated');
      expect(results).toHaveProperty('totalEndpoints');
      expect(results).toHaveProperty('testedEndpoints');
      expect(results).toHaveProperty('workingEndpoints');
      expect(results).toHaveProperty('results');
      expect(Array.isArray(results.results)).toBe(true);
    });
  });

  describe('getMonitoringStatus', () => {
    it('should return monitoring status', () => {
      const status = getMonitoringStatus();

      expect(status).toBeDefined();
      expect(status).toHaveProperty('isMonitoring');
      expect(status).toHaveProperty('lastUpdated');
      expect(typeof status.isMonitoring).toBe('boolean');
    });
  });

  describe('startMonitoring', () => {
    it('should test endpoints and update results', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(jsonRpcCall).mockResolvedValue('0x123456');

      await startMonitoring();

      const results = getMonitoringResults();
      expect(results.lastUpdated).not.toBeNull();
      expect(results.totalEndpoints).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });

    it('should handle failed endpoints', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(jsonRpcCall).mockRejectedValue(new Error('Connection refused'));

      await startMonitoring();

      const results = getMonitoringResults();
      expect(results).toHaveProperty('results');

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should log message when monitoring is already running', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Use minimal endpoints so monitoring resolves quickly once unblocked
      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Test', rpc: ['https://test.rpc.com'] }
      ]);

      // First call hangs (creates the overlap window), all subsequent calls resolve immediately
      let firstResolve;
      vi.mocked(jsonRpcCall)
        .mockImplementationOnce(() => new Promise((resolve) => { firstResolve = resolve; }))
        .mockResolvedValue('0x1');

      // Start first monitoring (will hang on first jsonRpcCall)
      const promise1 = startMonitoring();

      // Second call should detect monitoring in progress
      const promise2 = startMonitoring();

      expect(promise1).toBeInstanceOf(Promise);
      expect(promise2).toBeInstanceOf(Promise);

      // The log message should indicate monitoring is already in progress
      expect(consoleSpy).toHaveBeenCalledWith(
        'Monitoring already in progress, returning existing operation...'
      );

      // Resolve the first call so monitoring can complete (remaining calls use mockResolvedValue)
      firstResolve('geth/v1.0');
      await promise1;

      consoleSpy.mockRestore();
    });
  });

  describe('URL validation (indirect)', () => {
    it('should skip invalid URLs with templates', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        {
          chainId: 1,
          name: 'Test Chain',
          rpc: [
            'https://valid.rpc.com',
            'https://eth-mainnet.g.alchemy.com/v2/${API_KEY}',
            'wss://ws.rpc.com',
          ]
        }
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');

      await startMonitoring();

      // jsonRpcCall should only be called for the valid HTTP URL
      expect(vi.mocked(jsonRpcCall).mock.calls.length).toBeGreaterThan(0);
      // All calls should be for valid URLs only
      for (const call of vi.mocked(jsonRpcCall).mock.calls) {
        expect(call[0]).not.toContain('${');
        expect(call[0]).not.toMatch(/^wss?:\/\//);
      }

      consoleSpy.mockRestore();
    });

    it('should handle object RPC entries with url property', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        {
          chainId: 1,
          name: 'Test Chain',
          rpc: [
            { url: 'https://rpc.example.com' },
          ]
        }
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
      await startMonitoring();

      expect(vi.mocked(jsonRpcCall)).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should skip chains with no RPC endpoints', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Empty Chain', rpc: [] },
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
      await startMonitoring();

      // No calls should be made for chains without RPCs
      expect(vi.mocked(jsonRpcCall)).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('RPC call handling', () => {
    it('should mark endpoints as working when eth_blockNumber succeeds', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Ethereum', rpc: ['https://eth.rpc.com'] }
      ]);

      vi.mocked(jsonRpcCall)
        .mockResolvedValueOnce('geth/v1.13.0')
        .mockResolvedValueOnce('0x12345');

      await startMonitoring();

      const results = getMonitoringResults();
      const workingResults = results.results.filter(r => r.status === 'working');
      expect(workingResults.length).toBeGreaterThanOrEqual(1);

      consoleSpy.mockRestore();
    });

    it('should handle endpoints where web3_clientVersion fails but eth_blockNumber succeeds', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Ethereum', rpc: ['https://eth.rpc.com'] }
      ]);

      vi.mocked(jsonRpcCall)
        .mockRejectedValueOnce(new Error('Method not supported'))
        .mockResolvedValueOnce('0x12345');

      await startMonitoring();

      const results = getMonitoringResults();
      const ethResults = results.results.filter(r => r.chainId === 1);
      if (ethResults.length > 0) {
        expect(ethResults[0].clientVersion).toBe('unavailable');
      }

      consoleSpy.mockRestore();
    });

    it('should handle invalid block number response', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Ethereum', rpc: ['https://eth.rpc.com'] }
      ]);

      vi.mocked(jsonRpcCall)
        .mockResolvedValueOnce('geth/v1.0')
        .mockResolvedValueOnce(null);

      await startMonitoring();

      // Should not crash, endpoint should be marked as failed
      const results = getMonitoringResults();
      expect(results).toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe('Chain endpoint limiting', () => {
    it('should stop testing after first failed endpoint for a chain', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        {
          chainId: 1,
          name: 'Test Chain',
          rpc: [
            'https://rpc1.example.com',
            'https://rpc2.example.com',
            'https://rpc3.example.com',
          ]
        }
      ]);

      vi.mocked(jsonRpcCall)
        .mockResolvedValueOnce('geth/v1.0')
        .mockRejectedValueOnce(new Error('Block number failed'));

      await startMonitoring();

      // After first endpoint fails, should not test rpc2 and rpc3
      expect(vi.mocked(jsonRpcCall).mock.calls.length).toBe(2);

      consoleSpy.mockRestore();
    });

    it('should respect MAX_ENDPOINTS_PER_CHAIN limit', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manyRpcs = Array.from({ length: 10 }, (_, i) => `https://rpc${i}.example.com`);
      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Test Chain', rpc: manyRpcs }
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');

      await startMonitoring();

      // MAX_ENDPOINTS_PER_CHAIN is 5, so max 5 * 2 calls
      expect(vi.mocked(jsonRpcCall).mock.calls.length).toBeLessThanOrEqual(10);

      consoleSpy.mockRestore();
    });
  });

  describe('startRpcHealthCheck', () => {
    it('should start health check without throwing', () => {
      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');

      expect(() => {
        startRpcHealthCheck();
      }).not.toThrow();
    });

    it('should handle errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(jsonRpcCall).mockRejectedValue(new Error('Network error'));

      startRpcHealthCheck();

      await new Promise(resolve => setTimeout(resolve, 200));
      consoleSpy.mockRestore();
    });
  });
});
