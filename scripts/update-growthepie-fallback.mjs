#!/usr/bin/env node
// Regenerate data/growthepie-fallback.json from the live growthepie API: the normalized parts
// src/sources/growthepie.js serves when a file has never been read live (API down or gated).
// Daily histories are trimmed to keep the checked-in snapshot small; live reads carry the full 90
// days. Usage: node scripts/update-growthepie-fallback.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILES, refreshGrowthepie, getGrowthepieStatus, _snapshotParts } from '../src/sources/growthepie.js';

const FALLBACK_DAYS = 30;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'growthepie-fallback.json');

await refreshGrowthepie({ force: true });
const status = getGrowthepieStatus();
const failed = Object.entries(status.files).filter(([, f]) => f.source !== 'live').map(([name, f]) => `${name}: ${f.error ?? 'not read'}`);
if (failed.length) {
  console.error(`growthepie: not every file was read live, snapshot not written:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}

const parts = _snapshotParts();
const trim = byOrigin => Object.fromEntries(Object.entries(byOrigin).map(([origin, metrics]) => [
  origin, Object.fromEntries(Object.entries(metrics).map(([key, series]) => [key, series.slice(-FALLBACK_DAYS)]))
]));
parts.fundamentals = trim(parts.fundamentals);
parts.landing = { ...parts.landing, aggregates: trim(parts.landing.aggregates) };
parts.ethSupply = { ...parts.ethSupply, supplySeries: parts.ethSupply.supplySeries.slice(-FALLBACK_DAYS), issuanceSeries: parts.ethSupply.issuanceSeries.slice(-FALLBACK_DAYS) };

const snapshot = {
  about: 'Fallback for src/sources/growthepie.js: normalized growthepie parts (https://www.growthepie.com, chain-level Basic tier; attribution required). Regenerate with node scripts/update-growthepie-fallback.mjs. Histories trimmed to the last 30 days.',
  fetchedAt: new Date().toISOString(),
  files: Object.fromEntries(Object.entries(FILES).map(([name, f]) => [name, f.path])),
  parts
};
writeFileSync(OUT, `${JSON.stringify(snapshot)}\n`);
console.log(`wrote ${OUT} (${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB)`);
