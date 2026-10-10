import { searchChains, getChainDetail, getAllChains } from '../../store/queries.js';
import { getPricesForChains, getPriceForChain } from '../../../priceService.js';
import { MAX_SEARCH_QUERY_LENGTH, RATE_LIMIT_WINDOW_MS, SEARCH_RATE_LIMIT_MAX } from '../../../config.js';
import { parseIntParam } from '../util/parseIntParam.js';
import { sendError } from '../util/sendError.js';

const VALID_TAGS = ['Testnet', 'L2', 'Beacon', 'ZK', 'Validium', 'Optimium'];

export async function chainsRoutes(fastify) {
  fastify.get('/chains', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            enum: VALID_TAGS,
            errorMessage: { enum: `Invalid tag. Allowed: ${VALID_TAGS.join(', ')}` }
          },
          family: { type: 'string', minLength: 1, maxLength: 100 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const { tag, family } = request.query;
    let chains = getAllChains();
    if (tag) {
      chains = chains.filter(chain => chain.tags?.includes(tag));
    }
    if (family) {
      // Family labels are free text ("OP Stack", "OP Stack / Zora", "Matchain / OP Stack"),
      // so match a substring rather than the whole label.
      const wanted = family.toLowerCase();
      chains = chains.filter(chain => chain.family?.toLowerCase().includes(wanted));
    }
    const chainIds = chains.map(c => c.chainId);
    const priceMap = await getPricesForChains(chainIds);
    const enriched = chains.map(chain => ({
      ...chain,
      price: priceMap.get(chain.chainId) ?? null
    }));
    return { count: enriched.length, chains: enriched };
  });

  fastify.get('/chains/:id', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            pattern: '^-?\\d+$',
            errorMessage: 'Invalid chain ID'
          }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const chainId = parseIntParam(request.params.id);
    const chain = getChainDetail(chainId);
    if (!chain) return sendError(reply, 404, 'Chain not found');
    const price = await getPriceForChain(chainId);
    return { ...chain, price };
  });

  fastify.get('/search', {
    config: {
      rateLimit: { max: SEARCH_RATE_LIMIT_MAX, timeWindow: RATE_LIMIT_WINDOW_MS }
    },
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_SEARCH_QUERY_LENGTH,
            errorMessage: {
              minLength: 'Query parameter "q" is required',
              maxLength: `Query too long. Max length: ${MAX_SEARCH_QUERY_LENGTH}`
            }
          }
        },
        required: ['q'],
        additionalProperties: false,
        errorMessage: {
          required: { q: 'Query parameter "q" is required' }
        }
      }
    }
  }, async (request) => {
    const { q } = request.query;
    const results = searchChains(q);
    return { query: q, count: results.length, results };
  });
}
