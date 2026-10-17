#!/usr/bin/env node
// Enrich the existing, curated discovery list with a newer availability export.
// Usage: node scripts/import-channel-availability.mjs SOURCE.json [TARGET.json] [IMPORTED_AT]
// No network access. Identity/scope changes and additions require a separate review;
// an availability import must never promote unresolved or repurposed destinations.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ELIGIBLE = new Set(['confirmed', 'qualified']);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function chainId(value) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`Invalid chain ID: ${value}`);
  }
  return Number(value);
}

function channelKey(id, url) {
  // Match the published URL exactly, not a title, canonical alias, or array position.
  // Normalizing paths or case could merge distinct invitations/accounts.
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid channel URL for ${id}: ${url}`); }
  if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol) || (parsed.protocol === 'mailto:' && !parsed.pathname.includes('@'))) {
    throw new Error(`Unsupported channel URL for ${id}: ${url}`);
  }
  return `${chainId(id)}\n${url}`;
}

export function importChannelAvailability(published, revision, importedAt = new Date().toISOString()) {
  if (!Array.isArray(published?.networks) || !Array.isArray(revision?.networks)) throw new Error('Both inputs must contain networks arrays');
  if (!validDate(revision.generated_at_utc) || !validDate(importedAt)) throw new Error('Valid revision and import timestamps are required');
  if (validDate(published.updatedAt) && Date.parse(revision.generated_at_utc) < Date.parse(published.updatedAt)) {
    throw new Error('Refusing an older availability revision');
  }
  const eligible = new Map();
  const seenSource = new Set();
  const seenNetworks = new Set();
  for (const network of revision.networks) {
    const id = chainId(network.network_id);
    if (seenNetworks.has(id)) throw new Error(`Duplicate source chain ID: ${id}`);
    seenNetworks.add(id);
    if (!Array.isArray(network.channels)) throw new Error(`Missing source channels: ${id}`);
    for (const channel of network.channels) {
      if (!ELIGIBLE.has(channel.verification_status) || channel.access_status === 'repurposed') continue;
      const key = channelKey(id, channel.url);
      if (seenSource.has(key)) throw new Error(`Duplicate source channel: ${key}`);
      seenSource.add(key);
      eligible.set(key, channel);
    }
  }
  const result = structuredClone(published);
  const seenPublished = new Set();
  const seenPublishedNetworks = new Set();
  for (const network of result.networks) {
    const id = chainId(network.chainId);
    if (seenPublishedNetworks.has(id)) throw new Error(`Duplicate published chain ID: ${id}`);
    seenPublishedNetworks.add(id);
    if (!Array.isArray(network.channels)) throw new Error(`Missing published channels: ${id}`);
    for (const channel of network.channels) {
      const key = channelKey(id, channel.url);
      if (seenPublished.has(key)) throw new Error(`Duplicate published channel: ${key}`);
      seenPublished.add(key);
      const source = eligible.get(key);
      if (!source || !ELIGIBLE.has(channel.verification) || channel.access === 'repurposed') {
        throw new Error(`Published channel lacks an eligible exact source match: ${key}`);
      }
      for (const [target, original] of Object.entries({ platform: 'platform', verification: 'verification_status', relationship: 'relationship', scope: 'network_scope', access: 'access_status', invitation: 'invitation_status' })) {
        if (channel[target] !== source[original]) throw new Error(`Attribution/access changed (${target}); review separately: ${key}`);
      }
      if (!Array.isArray(source.current_availability_checks) || !source.independent_verification || typeof source.independent_verification !== 'object') {
        throw new Error(`Missing availability or independent verification evidence: ${key}`);
      }
      // Keep the evidence objects verbatim, including nulls, cache-age notes,
      // historical-only observations, separate URL checks and failed retrievals.
      // Do not replace original check dates with the import/availability timestamp.
      channel.activity = source.activity_status;
      channel.lastActivity = source.latest_observed_activity;
      channel.checkedAt = source.checked_at_utc;
      channel.evidenceMode = source.evidence_mode;
      channel.independent_verification = structuredClone(source.independent_verification);
      channel.current_availability_checks = structuredClone(source.current_availability_checks);
      eligible.delete(key);
    }
  }
  if (eligible.size) throw new Error(`${eligible.size} new eligible channels need a separate discovery-list review`);
  result.updatedAt = revision.generated_at_utc;
  result.importedAt = importedAt;
  if (revision.availability_audit) result.availability_audit = structuredClone(revision.availability_audit);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourcePath, targetPath = 'data/channel-research.json', importedAt] = process.argv.slice(2);
  if (!sourcePath) {
    console.error('Usage: node scripts/import-channel-availability.mjs SOURCE.json [TARGET.json] [IMPORTED_AT]');
    process.exitCode = 1;
  } else {
    const result = importChannelAvailability(JSON.parse(readFileSync(targetPath, 'utf8')), JSON.parse(readFileSync(sourcePath, 'utf8')), importedAt);
    // Validate the complete import before writing anything.
    writeFileSync(targetPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Imported ${result.networks.reduce((count, network) => count + network.channels.length, 0)} channels across ${result.networks.length} networks; revision ${result.updatedAt}`);
  }
}
