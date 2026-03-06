import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing rpcMonitor
vi.mock('../../config.js', () => ({
  MAX_ENDPOINTS_PER_CHAIN: 5,
  RPC_CHECK_CONCURRENCY: 5,
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

      // Each call resolves after a short delay, giving us time to call startMonitoring twice
      vi.mocked(jsonRpcCall)
        .mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('0x1'), 100)));

      // Start first monitoring (will be in-flight for ~100ms)
      const promise1 = startMonitoring();

      // Allow microtask queue to flush so monitoring enters the async loop
      await new Promise(resolve => setTimeout(resolve, 10));

      // Second call should detect monitoring in progress
      const promise2 = startMonitoring();

      expect(promise1).toBeInstanceOf(Promise);
      expect(promise2).toBeInstanceOf(Promise);

      // The log message should indicate monitoring is already in progress
      expect(consoleSpy).toHaveBeenCalledWith(
        'Monitoring already in progress, returning existing operation...'
      );

      // Wait for monitoring to complete
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
    it('should test all endpoints even if some fail', async () => {
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
        .mockResolvedValueOnce('geth/v1.0')       // rpc1 web3_clientVersion
        .mockRejectedValueOnce(new Error('Block number failed'))  // rpc1 eth_blockNumber
        .mockResolvedValueOnce('geth/v1.0')       // rpc2 web3_clientVersion
        .mockResolvedValueOnce('0x123')            // rpc2 eth_blockNumber
        .mockResolvedValueOnce('geth/v1.0')       // rpc3 web3_clientVersion
        .mockResolvedValueOnce('0x456');           // rpc3 eth_blockNumber

      await startMonitoring();

      // All 3 endpoints should be tested (6 jsonRpcCalls: 2 per endpoint)
      expect(vi.mocked(jsonRpcCall).mock.calls.length).toBe(6);

      const results = getMonitoringResults();
      // Should have both working and failed results
      expect(results.results.filter(r => r.status === 'failed').length).toBe(1);
      expect(results.results.filter(r => r.status === 'working').length).toBe(2);

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

  describe('Edge cases for URL handling', () => {
    it('should handle non-string, non-object RPC entries (extractUrl returns null)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        {
          chainId: 1,
          name: 'Test Chain',
          rpc: [
            42,           // number - not string or object
            null,         // null
            undefined,    // undefined
            true,         // boolean
          ]
        }
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
      await startMonitoring();

      // None of these should result in jsonRpcCall being called
      expect(vi.mocked(jsonRpcCall)).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should skip URLs that are not http or https', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        {
          chainId: 1,
          name: 'Test Chain',
          rpc: [
            'ftp://ftp.example.com',
            'custom://custom.rpc',
          ]
        }
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');
      await startMonitoring();

      expect(vi.mocked(jsonRpcCall)).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Block number parsing edge cases', () => {
    it('should handle NaN block number response (TypeError path)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Ethereum', rpc: ['https://eth.rpc.com'] }
      ]);

      // web3_clientVersion succeeds, but eth_blockNumber returns non-hex string
      vi.mocked(jsonRpcCall)
        .mockResolvedValueOnce('geth/v1.0')
        .mockResolvedValueOnce('not-a-hex-number');

      await startMonitoring();

      const results = getMonitoringResults();
      expect(results).toBeDefined();

      consoleSpy.mockRestore();
    });
  });

  describe('Progress logging', () => {
    it('should log progress every 50 endpoints', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Create enough endpoints to hit 50 tested count
      const rpcs = Array.from({ length: 51 }, (_, i) => `https://rpc${i}.example.com`);
      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Chain A', rpc: rpcs.slice(0, 5) },
        { chainId: 2, name: 'Chain B', rpc: rpcs.slice(5, 10) },
        { chainId: 3, name: 'Chain C', rpc: rpcs.slice(10, 15) },
        { chainId: 4, name: 'Chain D', rpc: rpcs.slice(15, 20) },
        { chainId: 5, name: 'Chain E', rpc: rpcs.slice(20, 25) },
        { chainId: 6, name: 'Chain F', rpc: rpcs.slice(25, 30) },
        { chainId: 7, name: 'Chain G', rpc: rpcs.slice(30, 35) },
        { chainId: 8, name: 'Chain H', rpc: rpcs.slice(35, 40) },
        { chainId: 9, name: 'Chain I', rpc: rpcs.slice(40, 45) },
        { chainId: 10, name: 'Chain J', rpc: rpcs.slice(45, 51) },
      ]);

      vi.mocked(jsonRpcCall).mockResolvedValue('0x1');

      await startMonitoring();

      // Should have logged the "Tested 50 endpoints" message
      const progressLogs = consoleSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('Tested 50')
      );
      expect(progressLogs.length).toBeGreaterThanOrEqual(1);

      consoleSpy.mockRestore();
    });
  });

  describe('testAllEndpoints error handling', () => {
    it('should handle errors thrown by getAllEndpoints', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockImplementation(() => {
        throw new Error('Data not loaded');
      });

      // startMonitoring should catch the error internally
      await startMonitoring();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error during RPC monitoring:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('testChainEndpoints error path', () => {
    it('should log error when testRpcEndpoint throws unexpectedly', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.mocked(getAllEndpoints).mockReturnValue([
        { chainId: 1, name: 'Test', rpc: ['https://rpc.example.com'] }
      ]);

      // Make jsonRpcCall throw an error that propagates past testRpcEndpoint's catch
      // The first call (web3_clientVersion) throws, then eth_blockNumber also throws
      vi.mocked(jsonRpcCall).mockRejectedValue(new Error('Connection reset'));

      await startMonitoring();

      const results = getMonitoringResults();
      expect(results).toBeDefined();

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
