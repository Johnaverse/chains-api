// Regenerate data/defillama-fallback.json from the live DefiLlama config.
// Usage: node scripts/refresh-defillama-fallback.mjs
import { writeFile } from 'node:fs/promises';
import { normalizeDefiLlamaConfig } from '../src/sources/defillama.js';
import { DATA_SOURCE_DEFILLAMA_CONFIG } from '../config.js';

const response = await fetch(DATA_SOURCE_DEFILLAMA_CONFIG, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`DefiLlama config fetch failed: ${response.status}`);
const chains = normalizeDefiLlamaConfig(await response.json());
if (chains.length === 0) throw new Error('DefiLlama config yielded 0 chains; refusing to overwrite the fallback');
chains.sort((a, b) => a.chainId - b.chainId);
const payload = { fetchedAt: new Date().toISOString(), source: DATA_SOURCE_DEFILLAMA_CONFIG, chains };
await writeFile(new URL('../data/defillama-fallback.json', import.meta.url), JSON.stringify(payload, null, 2) + '\n');
process.stdout.write(`wrote ${chains.length} chains\n`);
