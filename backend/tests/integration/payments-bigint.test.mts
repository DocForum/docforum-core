// Hermetic BigInt round-trip through Prisma 7's node-postgres driver adapter
// (Phase 8, issue #47).
//
// Why this file exists: the upgrade issue calls out `PaymentIntent.amount`
// (a Prisma `BigInt`, i.e. Postgres `bigint`, i.e. stroop count) as the field
// most likely to break when the Rust query engine is replaced by a driver
// adapter, and names the testnet payment test as its coverage. That test
// requires live testnet credentials *and* a funded platform payer identity
// (see tests/testnet-integration/payments.test.mts), so it cannot run in CI
// and cannot run for a contributor without those secrets — which leaves the
// single-risk field the issue cares about with no hermetic guard at all.
//
// This test covers exactly that risk and nothing else: a 64-bit stroop amount
// survives a write and a read through the new adapter without being coerced
// to a JavaScript `number`. The value chosen is 2^53 + 1, which IS
// representable as a Postgres bigint but is NOT representable as a double —
// so any silent number coercion would change it (to 2^53) and fail the
// assertion, rather than quietly rounding and passing.
//
// Self-contained embedded Postgres on its own port (5438), same pattern as the
// other files in this directory, so it runs alongside them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5440; // unique per integration file — 5438 collides with access-control
const runId = Date.now();

// 2^53 + 1 — exactly one more than Number.MAX_SAFE_INTEGER, so it only
// survives the round trip as a BigInt.
const UNSAFE_AMOUNT = 9_007_199_254_740_993n;
// A realistic stroop amount (0.05 XLM), to prove ordinary values work too.
const XLM_AMOUNT = 500_000n;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-bigint-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_bigint_test`;

describe('PaymentIntent BigInt round-trip (Prisma 7 driver adapter)', () => {
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let paymentsService: typeof import('../../src/modules/payments/services/index.js');
  let patientProfileId: string;
  let facilityId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_bigint_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Set before the dynamic imports below: src/config and the PrismaClient in
    // src/db/prisma-client.ts both read DATABASE_URL at import time (see the
    // same ordering note in csrf.test.mts).
    process.env.DATABASE_URL = databaseUrl;

    const dbModule = await import('../../src/db/prisma-client.js');
    prisma = dbModule.prisma;
    paymentsService = await import('../../src/modules/payments/services/index.js');

    const patientUser = await prisma.user.create({
      data: { email: `patient-bigint-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    const patient = await prisma.patientProfile.create({
      data: { userId: patientUser.id, fullName: 'BigInt Test Patient' },
    });
    patientProfileId = patient.id;

    const facilityUser = await prisma.user.create({
      data: { email: `facility-bigint-${runId}@example.com`, passwordHash: 'unused', role: 'facility' },
    });
    const facility = await prisma.facilityProfile.create({
      data: { userId: facilityUser.id, name: 'BigInt Test Facility', type: 'lab' },
    });
    facilityId = facility.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
  });

  async function roundTrip(amount: bigint, orderId: string) {
    // Goes through the module's own service, so this exercises the real write
    // path rather than a hand-built query.
    const order = await createOrderFixture(prisma, {
      patientProfileId, facilityProfileId: facilityId, kind: 'lab_order', amountStroops: amount, tag: orderId,
    });
    const created = await prisma.$transaction((tx) => paymentsService.createIntentForIssuedOrder(tx, {
      kind: 'lab_order', orderId: order.id, patientProfileId, doctorProfileId: order.doctorProfileId,
      facilityProfileId: facilityId, amountStroops: amount, supersedesId: null,
    }));
    expect(created.amount).toBe(amount);

    // Re-read from the database, bypassing the in-memory object the create
    // returned — this is the assertion that actually proves the adapter
    // round-trips the value.
    const reloaded = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: created.id } });
    return reloaded;
  }

  it('round-trips an amount above Number.MAX_SAFE_INTEGER without precision loss', async () => {
    const reloaded = await roundTrip(UNSAFE_AMOUNT, `bigint-unsafe-${runId}`);

    expect(typeof reloaded.amount).toBe('bigint');
    expect(reloaded.amount).toBe(UNSAFE_AMOUNT);
    // Guards against a future refactor that "helpfully" converts to Number.
    expect(Number(reloaded.amount)).not.toBe(UNSAFE_AMOUNT);
  });

  it('round-trips a realistic stroop amount', async () => {
    const reloaded = await roundTrip(XLM_AMOUNT, `bigint-normal-${runId}`);

    expect(typeof reloaded.amount).toBe('bigint');
    expect(reloaded.amount).toBe(XLM_AMOUNT);
  });

  it('round-trips a nullable BigInt (escrowId) as null, then as a value', async () => {
    const unfunded = await roundTrip(XLM_AMOUNT, `bigint-escrow-null-${runId}`);
    // Never funded: the optional BigInt column must stay null, not 0n.
    expect(unfunded.escrowId).toBeNull();

    const funded = await prisma.paymentIntent.update({
      where: { id: unfunded.id },
      data: { escrowId: UNSAFE_AMOUNT },
    });
    expect(funded.escrowId).toBe(UNSAFE_AMOUNT);

    const reloaded = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: unfunded.id } });
    expect(typeof reloaded.escrowId).toBe('bigint');
    expect(reloaded.escrowId).toBe(UNSAFE_AMOUNT);
  });
});
