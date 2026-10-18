#!/usr/bin/env node
// gen-field-key.mjs — generates a fresh AES-256 key for field-level
// encryption (Phase 8, issue #46) and prints the env var to set.
//
// Usage:
//   node scripts/gen-field-key.mjs          # generate v1 key
//   node scripts/gen-field-key.mjs v2       # generate a v2 (rotation) key
//
// The printed value is base64-encoded 32 bytes. Set it as:
//   FIELD_ENCRYPTION_KEY_V<N>=<value>
// NEVER commit real keys. For production, use your secrets manager.

import crypto from 'node:crypto';

const version = process.argv[2] ?? 'v1';
if (!/^v\d+$/.test(version)) {
  console.error(`Invalid version "${version}" — expected v1, v2, ...`);
  process.exit(1);
}

const key = crypto.randomBytes(32).toString('base64');
const envName = `FIELD_ENCRYPTION_KEY_${version.toUpperCase()}`;

console.log(`# Field-encryption key for ${version} (AES-256, base64)`);
console.log(`${envName}=${key}`);
console.log(`# Also set: FIELD_ENCRYPTION_ACTIVE_VERSION=${version}`);
