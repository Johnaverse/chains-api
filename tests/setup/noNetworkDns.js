import { vi } from 'vitest';

// Unit tests never touch real DNS. resolvesPublic (src/util/publicHost.js) looks hosts up before
// outbound requests; here every name answers "not found" at once, which the guard lets through
// (the request then fails on its own, as the tests' mocked fetches decide). Tests of the guard
// pass their own resolver.
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  lookup: vi.fn(async () => {
    throw Object.assign(new Error('DNS disabled in tests'), { code: 'ENOTFOUND' });
  })
}));
