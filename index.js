import { fileURLToPath as toFilePath } from 'node:url';
import { buildApp } from './src/http/app.js';
import { PORT, HOST } from './config.js';
import { startTracing } from './src/util/startTracing.js';
import { stopChainRefresher } from './src/services/chainRefresher.js';
import { closeRpcHealthDb } from './src/store/rpcHealthDb.js';

export { buildApp };

const __filename = toFilePath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
  const start = async () => {
    try {
      const tracing = await startTracing();
      const app = await buildApp();
      await app.listen({ port: PORT, host: HOST });
      app.log.info(`Server is running at http://${HOST}:${PORT}`);
      // On a signal: finish in-flight requests, then send the spans still buffered.
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await app.close().catch(() => {});
        await closeRpcHealthDb().catch(() => {});
        // Ends the sweep in progress (as not completed) so its span is sent with the rest.
        stopChainRefresher();
        await tracing.shutdown();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  };

  start();
}
