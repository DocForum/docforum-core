// Automatic escrow settlement (Phase 5.5, issues #83 and #84) —
// integration coverage against a real Postgres and the real transactional
// outbox, with the escrow SDK mocked (as the issues' definition of done
// requires: mock-RPC, not live testnet).
//
// What this proves:
//  - fulfilment confirmed (every item dispensed across all facilities) →
//    `order.fulfilled` commits WITH the status transition → the outbox worker
//    releases the escrow, audits it as automatic, and a re-delivery is a
//    no-op;
//  - a simulated RPC failure leaves the event pending; the retried delivery
//    releases exactly once;
//  - a wholesale rejection with nothing dispensed, and a lab order expiring
//    unfulfilled, each refund the escrow and notify the patient;
//  - a partially fulfilled order never releases (documented rule);
//  - an on-chain NotFunded is a terminal reconcile (`failed` + audit), not a
//    crash/retry loop.
//
// Self-contained embedded Postgres on its own port (5470), same harness as
// the other integration files.
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
const PORT = 5470; // unique per integration file
const runId = Date.now();

const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const CONTRACT_ID = NATIVE_SAC;
const payer = Keypair.random();
const releaser = Keypair.random();

// Before src/config is imported (dynamic imports in beforeAll).
process.env.ESCROW_CONTRACT_ID = CONTRACT_ID;
process.env.PLATFORM_PAYER_SECRET = payer.secret();
process.env.PLATFORM_RELEASER_SECRET = releaser.secret();
process.env.PAYMENT_ASSETS = JSON.stringify([{ code: 'XLM', tokenContractId: NATIVE_SAC, decimals: 7 }]);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-settlement-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_settlement_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

// The escrow SDK seam (issue #43): counts calls and can fail the next N
// release calls, either as a transient RPC error or as the contract's
// NotFunded terminal condition.
const sdkCalls = { release: 0, refund: 0 };
let transientReleaseFailures = 0;
let notFundedFailures = 0;

class FakeEscrowClient {
  async release() {
    sdkCalls.release += 1;
    if (notFundedFailures > 0) {
      notFundedFailures -= 1;
      throw Object.assign(new Error('escrow is not funded'), { code: 'NotFunded' });
    }
    if (transientReleaseFailures > 0) {
      transientReleaseFailures -= 1;
      throw new Error('simulated RPC outage');
    }
  }

  async refund() {
    sdkCalls.refund += 1;
  }
}

const patientRequester = () => ({ userId: patientUserId, role: 'patient' as const });
const facilityRequester = () => ({ userId: pharmacyUserId, role: 'facility' as const });

let app: App;
let prisma: Prisma;
let pharmacy: typeof import('../../src/modules/pharmacy-orders/services/index.js');
let paymentsService: typeof import('../../src/modules/payments/services/index.js');
let dispatchOutboxOnce: typeof import('../../src/jobs/outbox-events.js').dispatchOutboxOnce;
let expireUnfulfilledOrders: typeof import('../../src/jobs/lab-order-expiry.js').expireUnfulfilledOrders;

let patientUserId: string;
let patientProfileId: string;
let pharmacyUserId: string;
let pharmacyProfileId: string;
let labProfileId: string;
let escrowSequence = 0;

async function createEscrowedIntent(order: {
  id: string;
  kind: 'prescription' | 'lab_order';
  patientProfileId: string;
  facilityProfileId: string;
  amountStroops: bigint;
}) {
  escrowSequence += 1;
  return prisma.paymentIntent.create({
    data: {
      prescriptionId: order.kind === 'prescription' ? order.id : null,
      labOrderId: order.kind === 'lab_order' ? order.id : null,
      patientProfileId: order.patientProfileId,
      facilityId: order.facilityProfileId,
      amount: order.amountStroops,
      assetCode: 'XLM',
      tokenContractId: NATIVE_SAC,
      status: 'escrowed',
      escrowId: BigInt(9000 + escrowSequence),
      stellarTxHash: `funded-hash-${escrowSequence}`,
      sorobanContractId: CONTRACT_ID,
      fundedWalletAddress: Keypair.random().publicKey(),
    },
  });
}

async function createPrescription(extraItems = 0) {
  const order = await createOrderFixture(prisma as never, {
    patientProfileId,
    facilityProfileId: pharmacyProfileId,
    kind: 'prescription',
    amountStroops: 10_000_000n,
    tag: `settlement-${runId}-${escrowSequence + 1}`,
  });
  for (let index = 0; index < extraItems; index += 1) {
    await prisma.prescriptionItem.create({
      data: {
        prescriptionId: order.id,
        drugName: `Extra medicine ${index}`,
        dosage: '1 tablet',
        frequency: 'daily',
        duration: '5 days',
      },
    });
  }
  return order;
}

async function createLabOrder() {
  return createOrderFixture(prisma as never, {
    patientProfileId,
    facilityProfileId: labProfileId,
    kind: 'lab_order',
    amountStroops: 5_000_000n,
    tag: `settlement-lab-${runId}-${escrowSequence + 1}`,
  });
}

async function routeAndDispense(
  order: { id: string; kind: 'prescription' | 'lab_order' },
  howMany: number,
) {
  const record = await pharmacy.createFulfillment(
    {
      orderType: order.kind,
      orderId: order.id,
      facilityId: order.kind === 'prescription' ? pharmacyProfileId : labProfileId,
    },
    patientRequester(),
  );
  const toDispense = record.items.slice(0, howMany);
  for (const item of toDispense) {
    await pharmacy.updateFulfillmentItem(record.id, item.id, { status: 'dispensed' }, facilityRequester());
  }
  return record;
}

async function dispatchUntilNoDue(): Promise<void> {
  // A single dispatch processes every currently-due event (batch >= 50 in
  // these tests). Retry-scheduled events are made due by the failure test.
  await dispatchOutboxOnce(50);
}

describe('automatic escrow settlement (issues #83 and #84)', () => {
  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_settlement_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;

    const { createApp } = await import('../../src/app.js');
    app = createApp();
    expect(app).toBeTruthy();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    pharmacy = await import('../../src/modules/pharmacy-orders/services/index.js');
    paymentsService = await import('../../src/modules/payments/services/index.js');
    ({ dispatchOutboxOnce } = await import('../../src/jobs/outbox-events.js'));
    ({ expireUnfulfilledOrders } = await import('../../src/jobs/lab-order-expiry.js'));
    const handlers = await import('../../src/events/handlers.js');
    handlers.registerDomainEventHandlers();

    paymentsService.setEscrowSdkForTests({
      Keypair,
      EscrowClient: FakeEscrowClient,
    } as never);

    const patient = await prisma.user.create({
      data: { email: `settlement-patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    patientUserId = patient.id;
    patientProfileId = (
      await prisma.patientProfile.create({ data: { userId: patient.id, fullName: 'Settlement Patient' } })
    ).id;

    const pharmacyUser = await prisma.user.create({
      data: { email: `settlement-pharmacy-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    pharmacyUserId = pharmacyUser.id;
    pharmacyProfileId = (
      await prisma.facilityProfile.create({
        data: { userId: pharmacyUser.id, name: 'Settlement Pharmacy', type: 'pharmacy' },
      })
    ).id;

    const labUser = await prisma.user.create({
      data: { email: `settlement-lab-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    labProfileId = (
      await prisma.facilityProfile.create({
        data: { userId: labUser.id, name: 'Settlement Lab', type: 'lab' },
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    paymentsService?.resetEscrowSdkOverride();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('releases the escrow when every item is dispensed, and a re-delivery is a no-op', async () => {
    const order = await createPrescription();
    const intent = await createEscrowedIntent(order);
    const before = sdkCalls.release;

    await routeAndDispense(order, 1);
    // The order transitioned and the event committed together.
    const event = await prisma.outboxEvent.findFirst({ where: { type: 'order.fulfilled' } });
    expect(event).not.toBeNull();
    expect(await prisma.prescription.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'fulfilled',
    });

    await dispatchUntilNoDue();
    expect(sdkCalls.release).toBe(before + 1);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('released');

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: 'PaymentIntent', entityId: intent.id, action: 'payment_intent.released' },
    });
    expect(audit?.fromState).toBe('escrowed');
    expect(audit?.toState).toBe('released');

    // Duplicate delivery (e.g. a crash after the SDK call, before the event
    // was marked processed) must not release twice.
    await dispatchUntilNoDue();
    expect(sdkCalls.release).toBe(before + 1);
  });

  it('retries a failed release through the outbox and settles on the next attempt', async () => {
    const order = await createPrescription();
    const intent = await createEscrowedIntent(order);
    const before = sdkCalls.release;
    transientReleaseFailures = 1;

    await routeAndDispense(order, 1);
    await dispatchUntilNoDue();

    // The handler failure is recorded and the event is pending, not lost.
    const pending = await prisma.outboxEvent.findFirst({ where: { type: 'order.fulfilled', status: 'pending' } });
    expect(pending).not.toBeNull();
    expect(pending?.attempts).toBe(1);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('escrowed');

    // The worker scheduled a backoff; make it due and run again.
    await prisma.outboxEvent.updateMany({
      where: { id: pending!.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    await dispatchUntilNoDue();

    expect(sdkCalls.release).toBe(before + 2);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('released');
    const processed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: pending!.id } });
    expect(processed.status).toBe('processed');
  });

  it('refunds a wholesale rejection and notifies the patient', async () => {
    const order = await createPrescription();
    const intent = await createEscrowedIntent(order);
    const before = sdkCalls.refund;

    const record = await pharmacy.createFulfillment(
      { orderType: 'prescription', orderId: order.id, facilityId: pharmacyProfileId },
      patientRequester(),
    );
    await pharmacy.updateFulfillmentRecord(record.id, { status: 'rejected' }, facilityRequester());
    await dispatchUntilNoDue();

    expect(sdkCalls.refund).toBe(before + 1);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('refunded');

    // The notification is a side effect after commit; poll briefly.
    let notification = await prisma.notification.findFirst({
      where: { userId: patientUserId, type: 'payment_refunded' },
    });
    for (let attempt = 0; attempt < 20 && !notification; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      notification = await prisma.notification.findFirst({
        where: { userId: patientUserId, type: 'payment_refunded' },
      });
    }
    expect(notification).not.toBeNull();
  });

  it('refunds a lab order that expires unfulfilled', async () => {
    const order = await createLabOrder();
    const intent = await createEscrowedIntent(order);
    const before = sdkCalls.refund;

    await prisma.labOrder.update({
      where: { id: order.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const expired = await expireUnfulfilledOrders();
    expect(expired).toBe(1);
    expect((await prisma.labOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('expired');
    expect(
      await prisma.outboxEvent.findFirst({
        where: { type: 'order.expired', payload: { path: ['orderId'], equals: order.id } },
      }),
    ).not.toBeNull();

    await dispatchUntilNoDue();
    expect(sdkCalls.refund).toBe(before + 1);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('refunded');
  });

  it('never releases a partially fulfilled order', async () => {
    const order = await createPrescription(1);
    const intent = await createEscrowedIntent(order);
    const before = sdkCalls.release;

    await routeAndDispense(order, 1);
    expect(await prisma.prescription.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'partially_fulfilled',
    });
    await dispatchUntilNoDue();

    expect(sdkCalls.release).toBe(before);
    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('escrowed');
  });

  it('treats an on-chain NotFunded as a terminal reconcile, not a crash', async () => {
    const order = await createPrescription();
    const intent = await createEscrowedIntent(order);
    notFundedFailures = 1;

    await routeAndDispense(order, 1);
    await dispatchUntilNoDue();

    expect((await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe('failed');
    const audit = await prisma.auditEvent.findFirst({
      where: {
        entityType: 'PaymentIntent',
        entityId: intent.id,
        action: 'payment_intent.settlement_not_funded',
      },
    });
    expect(audit?.toState).toBe('failed');
    // The event was handled (no retry loop, no dead letter).
    expect(await prisma.outboxEvent.count({ where: { type: 'order.fulfilled', status: 'dead' } })).toBe(0);
  });
});
