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
/**
 * Failure kinds where nothing answered at all — the name does not resolve, nothing listens, or no
 * reply came. Every other kind means the endpoint is there and said something.
 */
export const NO_ANSWER_FAILURES = new Set(['unreachable', 'timeout', 'tls_error']);

/**
 * What kind of failure this was, from the error itself, so a caller can tell an endpoint that is
 * gone (its name no longer resolves, nothing listens) from one that answered with an error.
 */
function failureKind(error) {
  if (Number.isInteger(error?.status)) return error.status === 429 ? 'rate_limited' : 'http_error';
  const code = error?.cause?.code ?? error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return 'unreachable';
  if (typeof code === 'string' && /CERT|TLS|SSL/i.test(code)) return 'tls_error';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection_error';
  // Anything else may be our own side (proxy, egress, a bug), so it says nothing about the endpoint.
  return 'unknown';
}

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
      const httpError = new Error(`HTTP ${response.status}`);
      httpError.status = response.status;
      httpError.kind = response.status === 429 ? 'rate_limited' : 'http_error';
      throw httpError;
    }

    let body;
    try {
      body = await response.json();
    } catch (parseError) {
      // A page, not JSON-RPC (a parked domain, a login wall, a site moved onto the RPC's
      // host): the host is up, the endpoint is not. Said plainly — the parser's own message
      // ("Unexpected token '<', "<!DOCTYPE "... is not valid JSON") is what readers saw.
      const html = /token '<'|"\s*<|<!doctype|<html/i.test(parseError?.message ?? '');
      const notJson = new Error(html ? 'Returned a web page (HTML), not JSON-RPC' : 'Returned a response that is not JSON-RPC');
      notJson.kind = 'invalid_response';
      throw notJson;
    }
    if (body.error) {
      const message = body.error.message || JSON.stringify(body.error);
      const rpcError = new Error(message);
      // The node answered: it is up, it just refused this method or request.
      rpcError.kind = 'rpc_error';
      throw rpcError;
    }

    return body.result;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('RPC request timed out');
      timeout.kind = 'timeout';
      throw timeout;
    }
    if (!error.kind) error.kind = failureKind(error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
