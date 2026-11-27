// Seeds the referral-accept contention scenario (issue #349) into the
// database at DATABASE_URL and writes the k6 input file.
//
//   cd backend
//   DATABASE_URL=postgresql://... npx tsx tests/load/seed-referral-accept-contention.mts
//
// Options (env): LOAD_REFERRALS (default 40), LOAD_SLOTS (default 4),
// LOAD_TEST_SEED_FILE (default tests/load/seed-referral-accept-contention.json).
// The server k6 targets must share this database and the same
// JWT_ACCESS_SECRET / FIELD_ENCRYPTION_KEY_V1, since the seeded patients'
// access tokens are minted here. Tokens live 15 minutes: seed right before
// the run. Never point this at the shared Render preview.
import fs from 'node:fs';
import path from 'node:path';
import { refuseSharedTargets } from './guard.mjs';

refuseSharedTargets(process.env.DATABASE_URL, process.env.LOAD_TEST_BASE_URL);
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must point at a local or dedicated load-test database.');
  process.exit(2);
}
// Fixture-only direct writes (doctor verification, slot trimming) run
// without a request identity, as in the integration suite.
process.env.RLS_TEST_BYPASS ??= '1';

const referralCount = Number(process.env.LOAD_REFERRALS ?? 40);
const slotCount = Number(process.env.LOAD_SLOTS ?? 4);
const seedFile = path.resolve(process.env.LOAD_TEST_SEED_FILE ?? 'tests/load/seed-referral-accept-contention.json');

const { createApp } = await import('../../src/app.js');
const { prisma } = await import('../../src/db/prisma-client.js');
const { installEmailCapture } = await import('../integration/helpers/fixtures.mjs');
const { seedReferralAcceptContention } = await import('./referral-accept-contention-lib.mjs');

const emailedTokens = new Map<string, string>();
await installEmailCapture(emailedTokens);
const seed = await seedReferralAcceptContention(createApp(), prisma, emailedTokens, {
  referralCount,
  slotCount,
  runId: Date.now(),
});
fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
console.log(`seeded ${seed.referrals.length} pending referrals into ${seed.slotIds.length} slots -> ${seedFile}`);
await prisma.$disconnect();
