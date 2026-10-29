// Issue #80 integration coverage: POST /payments/intents/:id/prepare's
// service layer against real Postgres (embedded, port 5440), with the SDK
// mocked through setEscrowSdkForTests — the definition of done asks for
// mock-RPC tests, not live testnet. Covers prepare, only-one-live-transaction
// (idempotent re-prepare), expiry back to `created` plus re-prepare, the
// patient-only ownership check, and the wallet-link preconditions.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { Keypair } from '@stellar/stellar-sdk';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5462;
const runId = Date.now();

const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

// Before src/config is imported (dynamic import in beforeAll).
process.env.PAYMENT_ASSETS = JSON.stringify([{ code: 'XLM', tokenContractId: NATIVE_SAC, decimals: 7 }]);
process.env.PAYMENT_ORDER_EXPIRY_HOURS = '72';
process.env.PAYMENT_REFUND_GRACE_HOURS = '24';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-prepare-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_prepare_test`;

/** Vitest's rejects matchers don't reliably see custom Error fields, so grab
 * the rejection and assert the fields directly. */
async function captureError(promise: Promise<unknown>): Promise<{ status?: number; code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; code?: string };
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

describe('prepare endpoint (issue #80)', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let paymentsService: typeof import('../../src/modules/payments/services/index.js');
  let patientUserId: string;
  let patientProfileId: string;
  let patientPublicKey: string;
  let otherPatientUserId: string;
  let otherPatientProfileId: string;
  let facilityId: string;
  let unlinkedFacilityId: string;

  const prepareCalls: Array<{
    payer: string;
    payee: string;
    token: string;
    amount: bigint;
    conditionRef: string;
    releaser: string;
    refundAfter: bigint;
  }> = [];
  let preparedCount = 0;

  const actor = (userId: string) => ({ userId, role: 'patient' as const, requestId: `prepare-${runId}` });

  async function createIntent(facility = facilityId, profileId = patientProfileId) {
    const order = await createOrderFixture(prisma, {
      patientProfileId: profileId,
      facilityProfileId: facility,
      kind: 'prescription',
      amountStroops: 500_000n,
      tag: `prepare-${runId}-${Math.random().toString(36).slice(2)}`,
    });
    return paymentsService.createPaymentIntent({
      orderType: 'prescription',
      orderId: order.id,
      patientProfileId: profileId,
      facilityId: facility,
      assetCode: 'XLM',
      amount: 500_000n,
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_prepare_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.PLATFORM_PAYER_SECRET = Keypair.random().secret();
    process.env.PLATFORM_RELEASER_SECRET = Keypair.random().secret();
    process.env.ESCROW_CONTRACT_ID = 'CTESTCONTRACT';

    const dbModule = await import('../../src/db/prisma-client.js');
    prisma = dbModule.prisma;
    paymentsService = await import('../../src/modules/payments/services/index.js');
    // Wallet funding is behind a feature flag (issue #132), off by default.
    await prisma.featureFlag.update({ where: { key: 'payments.wallet_funding' }, data: { enabled: true } });

    paymentsService.setEscrowSdkForTests({
      Keypair,
      EscrowClient: class {
        async prepareCreateEscrow(params: (typeof prepareCalls)[number]) {
          prepareCalls.push(params);
          preparedCount += 1;
          return { xdr: `unsigned-xdr-${preparedCount}`, txHash: `prepared-hash-${preparedCount}`, expiryLedger: 1_000 + preparedCount };
        }
      },
    } as never);

    const patientUser = await prisma.user.create({
      data: {
        email: `patient-prepare-${runId}@example.com`,
        passwordHash: 'unused',
        role: 'patient',
        emailVerifiedAt: new Date(),
      },
    });
    patientUserId = patientUser.id;
    patientProfileId = (
      await prisma.patientProfile.create({ data: { userId: patientUser.id, fullName: 'Prepare Patient' } })
    ).id;
    patientPublicKey = Keypair.random().publicKey();
    await prisma.walletLink.create({
      data: {
        ownerType: 'patient',
        ownerId: patientProfileId,
        stellarPublicKey: patientPublicKey,
        verificationMethod: 'sep10',
        activeOwnerKey: `patient:${patientProfileId}`,
      },
    });

    const otherUser = await prisma.user.create({
      data: { email: `patient-other-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    otherPatientUserId = otherUser.id;
    otherPatientProfileId = (
      await prisma.patientProfile.create({ data: { userId: otherUser.id, fullName: 'Other Patient' } })
    ).id;

    const facilityUser = await prisma.user.create({
      data: { email: `facility-prepare-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    facilityId = (
      await prisma.facilityProfile.create({
        data: { userId: facilityUser.id, name: 'Prepare Facility', type: 'pharmacy' },
      })
    ).id;
    await prisma.walletLink.create({
      data: {
        ownerType: 'facility',
        ownerId: facilityId,
        stellarPublicKey: Keypair.random().publicKey(),
        verificationMethod: 'sep10',
        activeOwnerKey: `facility:${facilityId}`,
      },
    });

    const unlinkedUser = await prisma.user.create({
      data: { email: `facility-nolink-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    unlinkedFacilityId = (
      await prisma.facilityProfile.create({
        data: { userId: unlinkedUser.id, name: 'Unlinked Facility', type: 'lab' },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('prepares an unsigned transaction and moves the intent to awaiting_signature', async () => {
    const intent = await createIntent();
    const before = Date.now();

    const result = await paymentsService.preparePaymentIntent(actor(patientUserId), intent.id);

    expect(result.intent.status).toBe('awaiting_signature');
    expect(result.txHash).toBe('prepared-hash-1');
    expect(result.xdr).toBe('unsigned-xdr-1');
    expect(result.expiryLedger).toBe(1001);
    expect(result.intent.preparedTxHash).toBe('prepared-hash-1');
    expect(result.intent.preparedXdr).toBe('unsigned-xdr-1');
    expect(result.refundAfter.getTime()).toBeGreaterThan(before + 95 * 60 * 60 * 1000);

    expect(prepareCalls.at(-1)).toMatchObject({
      payer: patientPublicKey,
      token: NATIVE_SAC,
      amount: 500_000n,
      conditionRef: intent.id,
      refundAfter: BigInt(Math.floor(result.refundAfter.getTime() / 1000)),
    });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: intent.id, action: 'payment_intent.prepared' },
    });
    expect([event.entityType, event.fromState, event.toState]).toEqual(['PaymentIntent', 'created', 'awaiting_signature']);
    expect(event.actorUserId).toBe(patientUserId);
    expect(event.metadata).toMatchObject({ preparedTxHash: 'prepared-hash-1', assetCode: 'XLM', amount: '500000' });
  });

  it('is idempotent while the prepared transaction is still live', async () => {
    const intent = await createIntent();
    const first = await paymentsService.preparePaymentIntent(actor(patientUserId), intent.id);
    const callsAfterFirst = prepareCalls.length;

    const second = await paymentsService.preparePaymentIntent(actor(patientUserId), intent.id);

    expect(second.txHash).toBe(first.txHash);
    expect(second.xdr).toBe(first.xdr);
    expect(prepareCalls).toHaveLength(callsAfterFirst);
  });

  it('expires a stale prepared transaction back to created and allows a fresh prepare', async () => {
    const intent = await createIntent();
    const first = await paymentsService.preparePaymentIntent(actor(patientUserId), intent.id);

    // Simulate the TTL passing while the sweep hasn't run.
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { preparedExpiresAt: new Date(Date.now() - 1_000) },
    });
    const now = new Date();
    const { expired } = await paymentsService.expireStalePreparedIntents(now);
    expect(expired).toBeGreaterThanOrEqual(1);

    const expiredIntent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(expiredIntent.status).toBe('created');
    expect(expiredIntent.preparedTxHash).toBeNull();
    expect(expiredIntent.preparedXdr).toBeNull();
    expect(expiredIntent.preparedExpiresAt).toBeNull();
    expect(expiredIntent.refundAfter).toBeNull();

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: intent.id, action: 'payment_intent.prepare_expired' },
    });
    expect([event.fromState, event.toState]).toEqual(['awaiting_signature', 'created']);

    const again = await paymentsService.preparePaymentIntent(actor(patientUserId), intent.id);
    expect(again.intent.status).toBe('awaiting_signature');
    expect(again.txHash).not.toBe(first.txHash);
  });

  it('returns 404 for another patient’s intent', async () => {
    const intent = await createIntent();

    const error = await captureError(paymentsService.preparePaymentIntent(actor(otherPatientUserId), intent.id));
    expect(error.status).toBe(404);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('created');
  });

  it('returns 409 WALLET_NOT_LINKED when the patient has no verified wallet', async () => {
    // Put an intent on the other patient, who has a profile but no wallet link.
    const order = await createOrderFixture(prisma, {
      patientProfileId: otherPatientProfileId,
      facilityProfileId: facilityId,
      kind: 'lab_order',
      amountStroops: 100n,
      tag: `no-wallet-${runId}`,
    });
    const intent = await paymentsService.createPaymentIntent({
      orderType: 'lab_order',
      orderId: order.id,
      patientProfileId: otherPatientProfileId,
      facilityId,
      assetCode: 'XLM',
      amount: 100n,
    });

    const error = await captureError(paymentsService.preparePaymentIntent(actor(otherPatientUserId), intent.id));
    expect(error.status).toBe(409);
    expect(error.code).toBe('WALLET_NOT_LINKED');
  });

  it('returns 409 FACILITY_WALLET_NOT_LINKED when the payee has no wallet', async () => {
    const intent = await createIntent(unlinkedFacilityId);

    const error = await captureError(paymentsService.preparePaymentIntent(actor(patientUserId), intent.id));
    expect(error.status).toBe(409);
    expect(error.code).toBe('FACILITY_WALLET_NOT_LINKED');
  });

  it('does not prepare a non-created intent', async () => {
    const intent = await createIntent();
    await paymentsService.preparePaymentIntent(actor(patientUserId), intent.id);
    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { status: 'escrowed' } });

    const error = await captureError(paymentsService.preparePaymentIntent(actor(patientUserId), intent.id));
    expect(error.status).toBe(409);
  });
});
