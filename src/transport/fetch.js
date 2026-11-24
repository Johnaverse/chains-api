import { proxyFetch } from '../../fetchUtil.js';
import { SOURCE_FETCH_MAX_RETRIES, SOURCE_FETCH_RETRY_BASE_MS } from '../../config.js';
import { logger } from '../util/logger.js';
import { incCounter } from '../util/metrics.js';

const SUPPORTED_FORMATS = new Set(['json', 'text']);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch JSON or text from a URL using proxyFetch, retrying transient failures
 * with exponential backoff before giving up.
 *
 * Returns null on error rather than throwing, so loaders can use
 * Promise.allSettled-style handling with consistent shapes. The retry exists
 * so a transient network blip at startup doesn't leave a source registry
 * permanently empty until a manual reload (boot-only sources issue).
 */
export async function fetchData(url, format = 'json') {
  // Validate before issuing any network I/O so unsupported callers fail
  // deterministically without a wasted outbound request.
  if (!SUPPORTED_FORMATS.has(format)) {
    logger.error({ url, format }, 'Unsupported fetch format');
    incCounter('chains_api_source_fetch_total', { url, outcome: 'bad_format' });
    return null;
  }

  const maxAttempts = Math.max(1, SOURCE_FETCH_MAX_RETRIES);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await proxyFetch(url);
      if (!response.ok) {
        // The body is not read: release its connection now rather than when it is collected.
        response.body?.cancel().catch(() => {});
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      // Parse the body BEFORE incrementing the success counter so a body-parse
      // failure doesn't double-count as both success and error in the catch.
      const body = format === 'json' ? await response.json() : await response.text();
      incCounter('chains_api_source_fetch_total', { url, outcome: 'success' });
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = SOURCE_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1);
        logger.warn({ url, attempt, maxAttempts, err: error.message }, 'Source fetch failed; retrying');
        incCounter('chains_api_source_fetch_total', { url, outcome: 'retry' });
        await sleep(delay);
      }
    }
  }

  logger.error({ url, attempts: maxAttempts, err: lastError?.message }, 'Source fetch failed');
  incCounter('chains_api_source_fetch_total', { url, outcome: 'error' });
  return null;
}
