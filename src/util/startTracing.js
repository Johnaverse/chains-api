import { createRequire } from 'node:module';
import { OTEL_ENABLED, OTEL_SERVICE_NAME, OTEL_SAMPLE_RATIO } from '../../config.js';
import { startTelemetry } from './telemetry.js';
import { logger } from './logger.js';

const { version } = createRequire(import.meta.url)('../../package.json');

/** Start tracing from the environment (config.js). Call it before the servers are built. */
export function startTracing() {
  return startTelemetry({ enabled: OTEL_ENABLED, serviceName: OTEL_SERVICE_NAME, sampleRatio: OTEL_SAMPLE_RATIO, version }, { logger });
}
