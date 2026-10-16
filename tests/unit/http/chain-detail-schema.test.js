import Fastify from 'fastify';
import Ajv from 'ajv';
import { describe, it, expect } from 'vitest';
import { chainDetailSchema } from '../../../src/http/schemas/chainDetail.js';
import {
  getNetworkResearch, loadNetworkResearch, loadForumResearch, loadNodeHardware, loadChannelResearch
} from '../../../src/sources/networkResearch.js';

// Exercise every checked-in record, including metadata that handcrafted fixtures
// might miss. This uses Fastify's actual serializer, not a mocked route handler
// or JSON.stringify substituted for the response pipeline.
describe('complete checked-in research response contract', () => {
  it('validates and round-trips every research network without coercion or field loss', async () => {
    const chainIds = new Set([
      ...loadNetworkResearch().byChainId.keys(),
      ...loadForumResearch().byChainId.keys(),
      ...loadNodeHardware().byChainId.keys(),
      ...loadChannelResearch().byChainId.keys()
    ]);
    expect(chainIds.size).toBeGreaterThan(3000);
    const validate = new Ajv({ strict: false }).compile(chainDetailSchema);
    const app = Fastify();
    app.get('/chains/:id', { schema: { response: { 200: chainDetailSchema } } }, async request => {
      const chainId = Number(request.params.id);
      const research = getNetworkResearch(chainId);
      return { chainId, price: null, ...(research ? { research } : {}) };
    });
    try {
      await app.ready();
      for (const chainId of chainIds) {
        const research = getNetworkResearch(chainId);
        const expected = { chainId, price: null, ...(research ? { research } : {}) };
        expect(validate(expected), `Chain ${chainId}: ${JSON.stringify(validate.errors)}`).toBe(true);
        const response = await app.inject(`/chains/${chainId}`);
        expect(response.statusCode, `Chain ${chainId}`).toBe(200);
        expect(response.json(), `Chain ${chainId}`).toEqual(expected);
      }
    } finally {
      await app.close();
    }
  });
});
