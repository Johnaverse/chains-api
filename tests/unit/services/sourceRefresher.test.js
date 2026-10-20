import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/loader.js', () => ({
  getFailedSources: vi.fn(),
  refreshAllSources: vi.fn()
}));

import { runSourceHealCheck } from '../../../src/services/sourceRefresher.js';
import { cachedData } from '../../../src/store/cache.js';
import { getFailedSources, refreshAllSources } from '../../../src/services/loader.js';

beforeEach(() => { vi.clearAllMocks(); cachedData.lastUpdated = new Date().toISOString(); });

describe('source self-healer', () => {
  it('does nothing when all sources are loaded', async () => {
    getFailedSources.mockReturnValue([]);
    const result = await runSourceHealCheck();
    expect(refreshAllSources).not.toHaveBeenCalled();
    expect(result.healed).toBe(false);
  });

  it('re-fetches and reports healed when a failed source recovers', async () => {
    // failed before the refresh, loaded after.
    getFailedSources.mockReturnValueOnce(['chainlist']).mockReturnValueOnce([]);
    refreshAllSources.mockResolvedValue({});
    const result = await runSourceHealCheck();
    expect(refreshAllSources).toHaveBeenCalledOnce();
    expect(result.healed).toBe(true);
  });

  it('reports not healed when the source is still failing after a refresh', async () => {
    getFailedSources.mockReturnValue(['theGraph']);
    refreshAllSources.mockResolvedValue({});
    const result = await runSourceHealCheck();
    expect(refreshAllSources).toHaveBeenCalledOnce();
    expect(result.healed).toBe(false);
  });

  it('swallows refresh errors and reports not healed', async () => {
    getFailedSources.mockReturnValue(['chains']);
    refreshAllSources.mockRejectedValue(new Error('network'));
    const result = await runSourceHealCheck();
    expect(result.healed).toBe(false);
  });

  it('reloads sources that loaded fine once they are older than REGISTRY_MAX_AGE_MS', async () => {
    getFailedSources.mockReturnValue([]);
    refreshAllSources.mockResolvedValue({});
    const loadedAt = Date.parse('2026-10-20T12:40:00Z');
    cachedData.lastUpdated = new Date(loadedAt).toISOString();
    expect((await runSourceHealCheck(loadedAt + 60 * 60 * 1000)).reloaded).toBeUndefined();
    expect(refreshAllSources).not.toHaveBeenCalled();
    expect((await runSourceHealCheck(loadedAt + 6 * 60 * 60 * 1000)).reloaded).toBe(true);
    expect(refreshAllSources).toHaveBeenCalledOnce();
  });

  it('keeps the loaded data when an age reload fails', async () => {
    getFailedSources.mockReturnValue([]);
    refreshAllSources.mockRejectedValue(new Error('registry down'));
    cachedData.lastUpdated = '2026-10-01T00:00:00Z';
    expect((await runSourceHealCheck(Date.parse('2026-10-20T00:00:00Z'))).reloaded).toBe(false);
  });
});
