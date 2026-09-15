// Real-network integration test for the payments module (Phase 5.5, see
// docs/adr/0004-custodial-payments-v1.md) — exercises the actual
// @docforum/escrow-sdk against live testnet, not a mock.
//
// Deliberately kept OUT of `tests/integration/` (and its `test:integration`
// script / CI job): it depends on testnet liveness and the platform payer
// identity's testnet XLM balance, a materially different reliability
// profile than this repo's other integration test (booking.test.mts,
// self-contained via embedded-postgres, no external network). Run
// manually via `npm run test:integration:payments-testnet`. Same
// reasoning as docforum-escrow's own sdk/tests/testnet-integration.test.ts.
//
// This directory is named `testnet-integration/`, NOT `integration-testnet/`
// — vitest's CLI path filter matches by substring, so a name starting with
// "integration-" would also get swept up by `vitest run tests/integration`
// (confirmed the hard way: it was, before this rename, and ran with the
// wrong DATABASE_URL since `test:integration` doesn't set
// DATABASE_URL_TEST). Keep this directory's name clear of that prefix.
//
// Requires PLATFORM_PAYER_SECRET/PLATFORM_RELEASER_SECRET/
// ESCROW_CONTRACT_ID/ESCROW_TOKEN_ID in .env (see
// scripts/gen-platform-identities.mjs) with the payer identity funded.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { Keypair } from '@stellar/stellar-sdk';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5435; // distinct from booking.test.mts's 5433 and gen-migration.mjs's 5434
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-payments-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_payments_test`;

async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!res.ok) throw new Error(`Friendbot funding failed: ${res.status} ${await res.text()}`);
  return kp;
}

describe('payments module against live testnet', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let paymentsService: typeof import('../../src/modules/payments/services/index.js');
  let facilityId: string;
  let patientProfileId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_payments_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // NOT `process.env.DATABASE_URL = databaseUrl` here — too late.
    // src/db/prisma-client.ts's PrismaClient reads the URL at import
    // time, and vitest.config.mts's `test.env.DATABASE_URL` already runs
    // before this file's code does. This test's npm script sets
    // `DATABASE_URL_TEST` instead, which that config file reads as an
    // override — same mechanism tests/integration/booking.test.mts's own
    // comment documents.
    const dbModule = await import('../../src/db/prisma-client.js');
    prisma = dbModule.prisma;
    paymentsService = await import('../../src/modules/payments/services/index.js');

    const facilityUser = await prisma.user.create({
      data: { email: `facility-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const facility = await prisma.facilityProfile.create({
      data: { userId: facilityUser.id, name: 'Test Facility', type: 'lab' },
    });
    facilityId = facility.id;

    const patientUser = await prisma.user.create({
      data: { email: `patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    const patient = await prisma.patientProfile.create({
      data: { userId: patientUser.id, fullName: 'Test Patient' },
    });
    patientProfileId = patient.id;

    const payoutWallet = await fundedKeypair();
    await paymentsService.linkWallet(facilityId, payoutWallet.publicKey());
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
  });

  it('funds and releases a payment intent end-to-end on testnet', async () => {
    const intent = await paymentsService.createPaymentIntent({
      orderType: 'lab_order',
      orderId: 'test-order-release',
      patientProfileId,
      facilityId,
      amountStroops: 500_000n, // 0.05 XLM
    });
    expect(intent.status).toBe('created');

    const funded = await paymentsService.fundPaymentIntent(intent.id);
    expect(funded.status).toBe('escrowed');
    expect(funded.escrowId).not.toBeNull();
    expect(funded.stellarTxHash).toBeTruthy();

    const released = await paymentsService.releasePaymentIntent(intent.id);
    expect(released.status).toBe('released');
  }, 60_000);

  it('funds and refunds a payment intent end-to-end on testnet', async () => {
    const intent = await paymentsService.createPaymentIntent({
      orderType: 'prescription',
      orderId: 'test-order-refund',
      patientProfileId,
      facilityId,
      amountStroops: 500_000n,
    });

    await paymentsService.fundPaymentIntent(intent.id);
    const refunded = await paymentsService.refundPaymentIntent(intent.id);
    expect(refunded.status).toBe('refunded');
  }, 60_000);

  it('rejects funding a payment intent for a facility with no linked wallet', async () => {
    const unlinkedFacilityUser = await prisma.user.create({
      data: { email: `facility-unlinked-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const unlinkedFacility = await prisma.facilityProfile.create({
      data: { userId: unlinkedFacilityUser.id, name: 'Unlinked Facility', type: 'pharmacy' },
    });

    const intent = await paymentsService.createPaymentIntent({
      orderType: 'prescription',
      orderId: 'test-order-unlinked',
      patientProfileId,
      facilityId: unlinkedFacility.id,
      amountStroops: 500_000n,
    });

    await expect(paymentsService.fundPaymentIntent(intent.id)).rejects.toThrow(/no linked wallet/);
  }, 30_000);
});
