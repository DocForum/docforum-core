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
import { createOrderFixture, createPaymentIntentForFixture } from '../integration/order-fixtures.mjs';
import { Keypair } from '@stellar/stellar-sdk';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5435; // distinct from booking.test.mts's 5433 and gen-migration.mjs's 5434
const runId = Date.now();

const USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
// Opt-in: funding a real USDC escrow needs the platform payer to hold both
// testnet USDC and a trustline to its issuer. There is no automated faucet
// for testnet USDC, so the positive case only runs when an operator has
// prepared the payer and sets this flag. The trustline-rejection case below
// always runs against live Horizon and needs no USDC.
const USDC_FUNDING_ENABLED = process.env.PAYMENT_TESTNET_USDC === 'true';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-payments-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_payments_test`;

// Phase 8, issue #43: fund/release/refund now take the audit actor. This
// suite calls the services directly (no HTTP request), so it acts as a
// system actor.
const TEST_ACTOR = { userId: null, role: null, requestId: `testnet-${runId}` };

async function fundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  let lastFailure: string | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
      if (res.ok) return kp;
      lastFailure = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : 'network error';
    }
    if (attempt < 4) {
      const backoff = Math.min(1000 * 2 ** attempt, 16_000);
      await new Promise((resolve) => setTimeout(resolve, backoff + Math.floor(Math.random() * 500)));
    }
  }
  throw new Error(`Friendbot funding failed after 5 attempts (${lastFailure}).`);
}

describe('payments module against live testnet', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let paymentsService: typeof import('../../src/modules/payments/services/index.js');
  let facilityId: string;
  let patientProfileId: string;
  let pharmacyFacilityId: string;

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

    const pharmacyUser = await prisma.user.create({ data: { email: `pharmacy-${runId}@example.com`, passwordHash: 'unused', role: 'facility' } });
    const pharmacy = await prisma.facilityProfile.create({ data: { userId: pharmacyUser.id, name: 'Test Pharmacy', type: 'pharmacy' } });
    pharmacyFacilityId = pharmacy.id;
    await paymentsService.linkWallet(pharmacyFacilityId, (await fundedKeypair()).publicKey());

    const patientUser = await prisma.user.create({
      data: { email: `patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    const patient = await prisma.patientProfile.create({
      data: { userId: patientUser.id, fullName: 'Test Patient' },
    });
    patientProfileId = patient.id;

    const payoutWallet = await fundedKeypair();
    // Issue #78 removed the typed-in link path: this live-testnet suite
    // arranges its payee directly as an explicitly-unverified legacy
    // link (test setup, not a product code path — there is no service
    // that can create one anymore). Unverified links still fund until
    // WALLET_LINK_UNVERIFIED_FUNDING_CUTOFF, which this suite does not
    // set, so the default grace window applies.
    await prisma.walletLink.create({
      data: {
        ownerType: 'facility',
        ownerId: facilityId,
        stellarPublicKey: payoutWallet.publicKey(),
        verificationMethod: 'unverified_legacy',
        activeOwnerKey: `facility:${facilityId}`,
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('funds and releases a payment intent end-to-end on testnet', async () => {
    const order = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: 500_000n, tag: `release-${runId}` });
    const intent = await createPaymentIntentForFixture(prisma, order);
    expect(intent.status).toBe('created');

    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);
    expect(funded.status).toBe('escrowed');
    expect(funded.escrowId).not.toBeNull();
    expect(funded.stellarTxHash).toBeTruthy();

    const transactionResponse = await fetch(`https://horizon-testnet.stellar.org/transactions/${funded.stellarTxHash}`);
    if (!transactionResponse.ok) {
      throw new Error(`Unable to retrieve testnet fee measurement: HTTP ${transactionResponse.status}`);
    }
    const transaction = (await transactionResponse.json()) as { fee_charged: string };
    console.log(
      `[payout privacy testnet] ${process.env.PAYOUT_PRIVACY_MODE ?? 'facility'} funding fee: ${transaction.fee_charged} stroops`,
    );

    const released = await paymentsService.releasePaymentIntent(TEST_ACTOR, intent.id);
    expect(released.status).toBe('released');
  }, 60_000);

  it('funds and refunds a payment intent end-to-end on testnet', async () => {
    const order = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: pharmacyFacilityId, kind: 'prescription', amountStroops: 500_000n, tag: `refund-${runId}` });
    const intent = await createPaymentIntentForFixture(prisma, order);

    await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);
    const refunded = await paymentsService.refundPaymentIntent(TEST_ACTOR, intent.id);
    expect(refunded.status).toBe('refunded');
  }, 60_000);

  it('rejects a USDC escrow when the payee has no trustline, before any on-chain call', async () => {
    const order = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: 100_000n, tag: `usdc-no-trustline-${runId}` });
    const intent = await paymentsService.createPaymentIntent({
      orderType: 'lab_order',
      orderId: order.id,
      patientProfileId,
      facilityId,
      assetCode: 'USDC',
      amount: 100_000n,
    });

    // The friendbot-funded payout wallet exists but has no USDC trustline.
    await expect(paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id)).rejects.toThrow(/trustline for USDC/);
  }, 30_000);

  it.skipIf(!USDC_FUNDING_ENABLED)('funds and releases a USDC escrow end-to-end on testnet', async () => {
    const order = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: 500_000n, tag: `usdc-release-${runId}` });
    const intent = await paymentsService.createPaymentIntent({
      orderType: 'lab_order',
      orderId: order.id,
      patientProfileId,
      facilityId,
      assetCode: 'USDC',
      amount: 500_000n, // 0.05 USDC (both testnet SACs use 7 decimals)
    });
    expect(intent.assetCode).toBe('USDC');
    expect(intent.tokenContractId).toBe(USDC_SAC);

    const funded = await paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id);
    expect(funded.status).toBe('escrowed');
    const released = await paymentsService.releasePaymentIntent(TEST_ACTOR, intent.id);
    expect(released.status).toBe('released');
  }, 60_000);

  it('rejects funding a payment intent for a facility with no linked wallet', async () => {
    const unlinkedFacilityUser = await prisma.user.create({
      data: { email: `facility-unlinked-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const unlinkedFacility = await prisma.facilityProfile.create({
      data: { userId: unlinkedFacilityUser.id, name: 'Unlinked Facility', type: 'pharmacy' },
    });

    const order = await createOrderFixture(prisma, { patientProfileId, facilityProfileId: unlinkedFacility.id, kind: 'prescription', amountStroops: 500_000n, tag: `unlinked-${runId}` });
    const intent = await createPaymentIntentForFixture(prisma, order);

    await expect(paymentsService.fundPaymentIntent(TEST_ACTOR, intent.id)).rejects.toThrow(/no linked wallet/);
  }, 30_000);
});
