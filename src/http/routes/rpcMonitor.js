import { getRpcMonitoringResults } from '../../store/queries.js';
import { getRpcMonitoringStatus } from '../../services/rpcHealth.js';
import { chainRpcMonitor } from '../../services/chainProfile.js';
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

    const view = await chainRpcMonitor(chainId);
    if (!view) return sendError(reply, 404, 'No monitoring results found for this chain');
    return view;
  });
}
