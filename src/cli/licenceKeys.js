#!/usr/bin/env node
// Licence keys for the MCP server (src/auth/licenceKeys.js), against the configured database:
//   node src/cli/licenceKeys.js create "<licensee name>"   prints the key once
//   node src/cli/licenceKeys.js list
//   node src/cli/licenceKeys.js revoke <id>               disconnects that licensee's connectors
// In the cluster: kubectl -n chains-api exec deploy/chains-api -- node src/cli/licenceKeys.js list
import { databaseConfigured, closeDatabase } from '../store/database.js';
import { createLicenceKey, listLicenceKeys, revokeLicenceKey } from '../auth/licenceKeys.js';

const iso = s => (s == null ? '-' : new Date(s * 1000).toISOString());

async function main([command, ...args]) {
  if (!databaseConfigured()) throw new Error('No database configured (CHAINS_API_DB_HOST, _USER, _PASSWORD): keys would not persist');
  if (command === 'create') {
    const { id, name, key } = await createLicenceKey(args.join(' '));
    console.log(`Licence key for ${name} (id ${id}). It is shown once and stored only as a hash:\n\n  ${key}\n`);
  } else if (command === 'list') {
    const keys = await listLicenceKeys();
    if (!keys.length) console.log('No licence keys.');
    for (const k of keys) console.log(`${k.id}  ${k.revokedAt ? 'revoked' : 'active '}  created ${iso(k.createdAt)}  last used ${iso(k.usedAt)}  ${k.name}`);
  } else if (command === 'revoke') {
    if (!args[0]) throw new Error('Give the key id (from list)');
    console.log((await revokeLicenceKey(args[0])) ? `Revoked ${args[0]}; its connectors are disconnected.` : `No active key ${args[0]}.`);
  } else {
    throw new Error('Usage: licenceKeys.js create "<name>" | list | revoke <id>');
  }
}

main(process.argv.slice(2))
  .catch(err => { console.error(err.message); process.exitCode = 1; })
  .finally(() => closeDatabase());
