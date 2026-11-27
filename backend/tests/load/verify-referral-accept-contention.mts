// Post-run database check for the referral-accept contention load test
// (issue #349). Exits 1 on any violated invariant: a double-booked slot, or
// a referral that is not either accepted with exactly one appointment or
// still pending with none. HTTP status codes are not consulted.
//
//   cd backend
//   DATABASE_URL=postgresql://... npx tsx tests/load/verify-referral-accept-contention.mts
import fs from 'node:fs';
import path from 'node:path';
import { refuseSharedTargets } from './guard.mjs';

refuseSharedTargets(process.env.DATABASE_URL);
process.env.RLS_TEST_BYPASS ??= '1';
const seedFile = path.resolve(process.env.LOAD_TEST_SEED_FILE ?? 'tests/load/seed-referral-accept-contention.json');

const { prisma } = await import('../../src/db/prisma-client.js');
const { verifyReferralAcceptContention } = await import('./referral-accept-contention-lib.mjs');

const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const { violations, accepted, pending } = await verifyReferralAcceptContention(prisma, seed);
await prisma.$disconnect();

console.log(`referral accept contention: accepted=${accepted} pending=${pending} slots=${seed.slotIds.length}`);
if (accepted === 0) violations.push('no referral was accepted; the run did not exercise the accept path');
if (violations.length > 0) {
  console.error(`${violations.length} invariant violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('all database invariants hold');
