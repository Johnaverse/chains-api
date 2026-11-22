import { fileURLToPath as toFilePath } from 'node:url';
import { buildApp } from './src/http/app.js';
import { PORT, HOST } from './config.js';
import { startTracing } from './src/util/startTracing.js';

export { buildApp };

const __filename = toFilePath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
  const start = async () => {
    try {
      await startTracing();
      const app = await buildApp();
      await app.listen({ port: PORT, host: HOST });
      app.log.info(`Server is running at http://${HOST}:${PORT}`);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  };

  start();
}
