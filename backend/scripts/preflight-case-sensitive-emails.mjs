#!/usr/bin/env node
// Preflight check for case-insensitive email migration (Phase 8, issue #268).
//
// Detects existing accounts whose email addresses differ only in casing
// (e.g. "Ana@x.com" and "ana@x.com"). The database migration enforces
// case-insensitive uniqueness with a unique index on LOWER("email");
// applying the migration against a database with case collisions will fail.
//
// Usage:
//   node backend/scripts/preflight-case-sensitive-emails.mjs
//
// Exit codes:
//   0: No collisions found; safe to migrate.
//   1: Collisions detected or database connection error.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Running preflight check for case-sensitive email collisions...');

  let collisions = [];
  try {
    collisions = await prisma.$queryRaw`
      SELECT
        LOWER("email") AS "lowerEmail",
        COUNT(*)::int AS "count",
        ARRAY_AGG("id") AS "ids",
        ARRAY_AGG("email") AS "emails"
      FROM "User"
      GROUP BY LOWER("email")
      HAVING COUNT(*) > 1
    `;
  } catch (error) {
    console.error('Database query failed:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }

  if (collisions.length === 0) {
    console.log('Preflight check passed: No case-duplicate email accounts found. Safe to apply migration.');
    process.exit(0);
  }

  console.error(`\nFAILED: Found ${collisions.length} collision group(s) with different email casing:\n`);
  for (const group of collisions) {
    console.error(`- Normalised email: ${group.lowerEmail} (${group.count} accounts)`);
    for (let i = 0; i < group.ids.length; i++) {
      console.error(`    User ID: ${group.ids[i]} | Exact email in DB: ${group.emails[i]}`);
    }
  }

  console.error('\nOperator resolution:');
  console.error('Before applying migration 20261124160000_case_insensitive_user_email, each collision must be resolved.');
  console.error('Options:');
  console.error('1. If an account is obsolete or duplicate, update or tombstone the email:');
  console.error('   UPDATE "User" SET email = \'duplicate+\' || id || \'@deleted.invalid\' WHERE id = \'<userId>\';');
  console.error('2. If both accounts are legitimate, coordinate with the user to change one account\'s email address.');
  console.error('Re-run this preflight script after resolving to confirm zero collisions.\n');

  process.exit(1);
}

main().catch((err) => {
  console.error('Unexpected error during preflight:', err);
  process.exit(1);
});
