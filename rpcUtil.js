import { proxyFetch } from './fetchUtil.js';

/**
 * Perform a JSON-RPC call with timeout and error handling.
 * @param {string} url - RPC endpoint URL
 * @param {string} method - JSON-RPC method name
 * @param {Object} options - Optional configuration
 * @param {Array} options.params - JSON-RPC params (default: [])
 * @param {number} options.timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns {Promise<*>} The result field from the JSON-RPC response
 */
export async function jsonRpcCall(url, method, { params = [], timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await proxyFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const body = await response.json();
    if (body.error) {
      const message = body.error.message || JSON.stringify(body.error);
      throw new Error(message);
    }

    return body.result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('RPC request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
