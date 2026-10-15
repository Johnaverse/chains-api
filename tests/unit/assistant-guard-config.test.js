import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each([
  ['', 60000], ['45000', 45000], ['120001', 120000], ['0', 60000],
  ['-1', 60000], ['NaN', 60000], ['Infinity', 60000], ['3.5', 60000],
  ['45000oops', 60000], ['9007199254740992', 60000]
])('bounds ASSISTANT_GUARD_TIMEOUT_MS=%s to %i', async (raw, expected) => {
  vi.stubEnv('ASSISTANT_GUARD_TIMEOUT_MS', raw);
  vi.resetModules();
  const config = await import('../../../config.js');
  expect(config.ASSISTANT_GUARD_TIMEOUT_MS).toBe(expected);
});
