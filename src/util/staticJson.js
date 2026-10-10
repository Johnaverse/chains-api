import { readFileSync } from 'node:fs';
import { logger } from './logger.js';

/**
 * Read one of the checked-in JSON datasets under data/ at module init. The files ship
 * with the image, so a failure is a packaging bug, not a runtime condition: log it and
 * hand back `fallback` so the caller degrades to "no data" instead of crashing the boot.
 */
export function readStaticJson(path, label, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    logger.warn({ err: err.message, path }, `${label} unavailable`);
    return fallback;
  }
}
