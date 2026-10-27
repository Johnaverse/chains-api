import { getRpcMonitoringResults } from '../../store/queries.js';
import { getRpcMonitoringStatus } from '../../services/rpcHealth.js';
import { ensureChainRpcResults } from '../../services/chainRefresher.js';
import { summarizeChainClients } from '../../../clientsView.js';
import { parseIntParam } from '../util/parseIntParam.js';
import { sendError } from '../util/sendError.js';

const intIdParam = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: '^-?\\d+$',
      errorMessage: 'Invalid chain ID'
    }
  },
  required: ['id']
};

export async function rpcMonitorRoutes(fastify) {
  fastify.get('/rpc-monitor', async () => {
    const results = getRpcMonitoringResults();
    const status = getRpcMonitoringStatus();
    return { ...status, ...results };
  });

  fastify.get('/rpc-monitor/:id', {
    schema: { params: intIdParam }
  }, async (request, reply) => {
    const chainId = parseIntParam(request.params.id);

    let results = getRpcMonitoringResults();
    let chainResults = results.results.filter(r => r.chainId === chainId);

    // Post-deploy blind window: the rolling sweep may not have reached this
    // chain yet. Probe its endpoints on demand instead of answering "nothing".
    if (chainResults.length === 0 && await ensureChainRpcResults(chainId)) {
      results = getRpcMonitoringResults();
      chainResults = results.results.filter(r => r.chainId === chainId);
    }

    if (chainResults.length === 0) {
      return sendError(reply, 404, 'No monitoring results found for this chain');
    }

    const workingCount = chainResults.filter(r => r.status === 'working').length;
    const failedCount = chainResults.filter(r => r.status === 'failed').length;
    const rateLimitedCount = chainResults.filter(r => r.status === 'rate_limited').length;

    return {
      chainId,
      chainName: chainResults[0].chainName,
      totalEndpoints: chainResults.length,
      workingEndpoints: workingCount,
      failedEndpoints: failedCount,
      rateLimitedEndpoints: rateLimitedCount,
      lastUpdated: results.lastUpdated,
      endpoints: chainResults,
      clients: summarizeChainClients(chainResults)?.clients ?? []
    };
  });
}
