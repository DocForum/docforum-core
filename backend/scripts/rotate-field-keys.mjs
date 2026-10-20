#!/usr/bin/env node
// rotate-field-keys.mjs — re-encrypts rows with the newest key in batches
// (Phase 8, issue #46).
//
// Usage:
//   DATABASE_URL=postgresql://... node scripts/rotate-field-keys.mjs
//
// What it does:
//   1. Reads batches of rows whose encrypted columns are still under an
//      older key version (or plaintext, if any legacy rows exist).
//   2. Decrypts with the old key (or passes plaintext through).
//   3. Re-encrypts with the ACTIVE key version.
//   4. Writes back, batch by batch, with a small delay so a large table
//      doesn't lock everything at once.
//
// Env requirements:
//   DATABASE_URL              — the Postgres connection string
//   FIELD_ENCRYPTION_ACTIVE_VERSION — the target key version (e.g. v2)
//   FIELD_ENCRYPTION_KEY_V1   — the OLD key (to decrypt existing rows)
//   FIELD_ENCRYPTION_KEY_V2   — the NEW/active key (to re-encrypt)
//
// Idempotent: rows already under the active version are skipped, so a
// crashed run can be restarted safely.

import { PrismaClient } from '@prisma/client';
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

const BATCH_SIZE = Number(process.env.ROTATE_BATCH_SIZE ?? 200);
const DELAY_MS = Number(process.env.ROTATE_DELAY_MS ?? 50);

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// Which (table, column) pairs hold encrypted clinical text.
// Add new entries here as Phase 2/3/4 land more encrypted columns.
const ENCRYPTED_COLUMNS = [
  // Consultation.notes and Referral.snapshotNotes are Phase 0 placeholders
  // today (nullable/TODO FKs), but the columns exist in the schema — the
  // script handles them as soon as rows exist.
  { table: 'Consultation', column: 'notes' },
  { table: 'LabOrder', column: 'notes' },
  { table: 'Referral', column: 'snapshotNotes' },
];

function getKey(version) {
  const envName = `FIELD_ENCRYPTION_KEY_${version.toUpperCase()}`;
  const raw = process.env[envName];
  if (!raw) throw new Error(`Missing env var ${envName}`);
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${envName} must be 32 bytes`);
  return buf;
}

const activeVersion = process.env.FIELD_ENCRYPTION_ACTIVE_VERSION ?? 'v1';
const activeKey = getKey(activeVersion);

function decryptValue(ciphertext) {
  if (!ciphertext) return ciphertext;
  const parts = ciphertext.split(':');
  if (parts.length !== 4) return ciphertext; // not our format — leave alone
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version === activeVersion) return null; // already current, signal skip
  const key = getKey(version);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

function encryptValue(plaintext) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, activeKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${activeVersion}:${iv.toString('base64')}:${authTag.toString('base64')}:${enc.toString('base64')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const prisma = new PrismaClient();
  let totalRotated = 0;
  let totalSkipped = 0;

  try {
    for (const { table, column } of ENCRYPTED_COLUMNS) {
      console.log(`\n[${table}.${column}] rotating to ${activeVersion}...`);

      let processed = 0;
      for (;;) {
        // Batch: fetch rows not yet under the active version.
        // We filter with raw SQL because Prisma can't express "column
        // does not start with prefix" portably across the models here.
        const rows = await prisma.$queryRawUnsafe(
          `SELECT id, "${column}" FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" NOT LIKE $1 LIMIT ${BATCH_SIZE}`,
          `${activeVersion}:%`,
        );

        if (rows.length === 0) break;

        for (const row of rows) {
          const stored = row[column];
          const plaintext = decryptValue(stored);
          if (plaintext === null) {
            totalSkipped += 1;
            continue;
          }
          // plaintext === stored means it wasn't our envelope (legacy
          // plaintext) — encrypt it fresh under the active key.
          const toWrite = plaintext === stored ? encryptValue(stored) : encryptValue(plaintext);
          await prisma.$executeRawUnsafe(
            `UPDATE "${table}" SET "${column}" = $1 WHERE id = $2`,
            toWrite,
            row.id,
          );
          totalRotated += 1;
        }

        processed += rows.length;
        console.log(`  processed ${processed} rows...`);
        await sleep(DELAY_MS);
      }
    }

    console.log(`\nDone. rotated=${totalRotated} skipped_already_current=${totalSkipped}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Rotation failed:', err);
  process.exit(1);
});
