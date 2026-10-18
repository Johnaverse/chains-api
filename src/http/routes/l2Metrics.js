import {
  getL2Metrics,
  getL2MetricsForChain,
  getDaLayers,
  getEthSupply,
  getGrowthepieStatus,
  ATTRIBUTION
} from '../../sources/growthepie.js';
import { GROWTHEPIE_ENABLED } from '../../../config.js';
import { parseIntParam } from '../util/parseIntParam.js';
import { sendError } from '../util/sendError.js';

/**
 * growthepie L2 data (src/sources/growthepie.js): fundamentals, fees, economics, blockspace, DA.
 * Every answer carries `attribution` — growthepie's usage rules require it wherever it is shown.
 *
 * /l2-metrics            every covered chain, compact, plus the all-L2 aggregate and metric labels
 * /l2-metrics/da         data-availability layers: fees, data posted, consumers
 * /l2-metrics/eth-supply ETH supply and issuance rate, with supply events
 * /l2-metrics/status     per-file freshness (live / fallback) and last error
 * /l2-metrics/:chainId   one chain in full; ?series=false drops the 90-day daily history
 */
export async function l2MetricsRoutes(fastify) {
  const disabled = reply => sendError(reply, 404, 'growthepie data is disabled (GROWTHEPIE_ENABLED=false)');

  fastify.get('/l2-metrics', {
    schema: { description: 'Ethereum L2 metrics from growthepie for every covered chain (compact), with the all-L2 aggregate.' }
  }, async (request, reply) => (GROWTHEPIE_ENABLED ? getL2Metrics() : disabled(reply)));

  fastify.get('/l2-metrics/status', {
    schema: { description: 'Freshness of each growthepie file: live or fallback snapshot, fetch time and last error.' }
  }, async () => ({ attribution: ATTRIBUTION, ...getGrowthepieStatus() }));

  fastify.get('/l2-metrics/da', {
    schema: { description: 'Data-availability layers (Ethereum blobs, Celestia, EigenDA): fees, data posted and consumers per span, from growthepie.' }
  }, async (request, reply) => (GROWTHEPIE_ENABLED ? getDaLayers() : disabled(reply)));

  fastify.get('/l2-metrics/eth-supply', {
    schema: { description: 'ETH supply and issuance rate (latest and last year daily), with supply events, from growthepie.' }
  }, async (request, reply) => (GROWTHEPIE_ENABLED ? getEthSupply() : disabled(reply)));

  fastify.get('/l2-metrics/:chainId', {
    schema: {
      description: 'One chain from growthepie: profile, every fundamental metric (latest, 7d/30d change, daily history), fees, activity, economics, blockspace by category and DA layers used.',
      params: {
        type: 'object',
        properties: { chainId: { type: 'string', pattern: '^\\d+$', errorMessage: 'Invalid chain ID' } },
        required: ['chainId']
      },
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { series: { type: 'boolean', default: true } }
      }
    }
  }, async (request, reply) => {
    if (!GROWTHEPIE_ENABLED) return disabled(reply);
    const chainId = parseIntParam(request.params.chainId);
    const out = await getL2MetricsForChain(chainId, { series: request.query.series });
    if (!out) return sendError(reply, 404, `growthepie has no data for chain ${chainId}`);
    return out;
  });
}
