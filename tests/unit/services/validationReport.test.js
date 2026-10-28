import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = vi.hoisted(() => ({ lastUpdated: '2026-10-28T00:00:00Z' }));
vi.mock('../../../src/store/cache.js', () => ({ getCachedData: () => cache }));
vi.mock('../../../src/services/validation.js', () => ({ validateChainData: vi.fn() }));
const { validationReport, clearValidationReport, findingsForChain } = await import('../../../src/services/validationReport.js');

describe('validationReport', () => {
  beforeEach(() => { clearValidationReport(); cache.lastUpdated = '2026-10-28T00:00:00Z'; });

  it('reuses the report for the same data load within the TTL', () => {
    const validate = vi.fn(() => ({ totalErrors: 0, allErrors: [] }));
    validationReport(validate, 0);
    validationReport(validate, 30000);
    expect(validate).toHaveBeenCalledTimes(1);
    validationReport(validate, 61000);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when the data reloads, and never keeps an error', () => {
    const validate = vi.fn(() => ({ totalErrors: 0, allErrors: [] }));
    validationReport(validate, 0);
    cache.lastUpdated = '2026-10-28T01:00:00Z';
    validationReport(validate, 1000);
    expect(validate).toHaveBeenCalledTimes(2);
    const failing = vi.fn(() => ({ error: 'Data not loaded' }));
    validationReport(failing, 2000);
    validationReport(failing, 3000);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('findingsForChain', () => {
  it('keeps one chain\'s findings and the rules that have any', () => {
    const report = {
      allErrors: [{ rule: 1, chainId: 1 }, { rule: 21, chainId: 10 }],
      errorsByRule: { rule1: [{ rule: 1, chainId: 1 }], rule21: [{ rule: 21, chainId: 10 }] }
    };
    expect(findingsForChain(report, 1)).toEqual({
      chainId: 1, totalErrors: 1, errorsByRule: { rule1: [{ rule: 1, chainId: 1 }] }, allErrors: [{ rule: 1, chainId: 1 }]
    });
  });
});
