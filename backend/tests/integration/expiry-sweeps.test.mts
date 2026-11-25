import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';

// Set before the config/job modules are imported by the tests below.
process.env.EXPIRY_SWEEP_BATCH_SIZE = '3';
process.env.EXPIRY_SWEEP_MAX_PER_RUN = '5';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5499;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-expiry-sweeps-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  // Windows hosts default to a legacy cluster encoding that cannot store the
  // UTF-8 characters in the committed migrations. Force a UTF-8 cluster on
  // every platform so this test does not inherit the host locale.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_expiry_sweeps_test`;

type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type ExpireOrders = typeof import('../../src/jobs/order-expiry.js').expireUnconfirmedOrders;
type RunLabSweep = typeof import('../../src/jobs/lab-order-expiry.js').runExpireUnfulfilledOrders;

describe('batched expiry sweeps (issue #348)', () => {
  let prisma: Prisma;
  let expireUnconfirmedOrders: ExpireOrders;
  let runExpireUnfulfilledOrders: RunLabSweep;
  let patientProfileId: string;
  let facilityProfileId: string;
  let doctorProfileId: string;
  let slotCounter = 0;

  async function createOrder(options: {
    tag: string;
    fulfilledAt: Date;
    status?: 'fulfilled' | 'issued';
    disputed?: boolean;
    confirmed?: boolean;
  }) {
    return prisma.order.create({
      data: {
        orderType: 'pharmacy',
        patientProfileId,
        details: options.tag,
        status: options.status ?? 'fulfilled',
        fulfilledAt: options.fulfilledAt,
        disputed: options.disputed ?? false,
        confirmed: options.confirmed ?? false,
        confirmationSource: options.confirmed ? 'patient' : null,
      },
    });
  }

  async function createLabOrder(options: { tag: string; expiresAt: Date; status?: 'issued' | 'fulfilled' }) {
    slotCounter += 1;
    const start = new Date(Date.now() + slotCounter * 60 * 60 * 1000);
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        startTime: start,
        endTime: new Date(start.getTime() + 30 * 60 * 1000),
      },
    });
    const appointment = await prisma.appointment.create({
      data: { patientProfileId, doctorProfileId, availabilitySlotId: slot.id },
    });
    const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });
    return prisma.labOrder.create({
      data: {
        consultationId: consultation.id,
        patientProfileId,
        orderingDoctorId: doctorProfileId,
        facilityProfileId,
        amountStroops: 100n,
        testType: options.tag,
        status: options.status ?? 'issued',
        expiresAt: options.expiresAt,
      },
    });
  }

  async function expiredEventIds(ids: string[]): Promise<string[]> {
    const events = await prisma.outboxEvent.findMany({ where: { type: 'order.expired' } });
    return events
      .map((event) => (event.payload as { orderId?: string }).orderId)
      .filter((id): id is string => typeof id === 'string' && ids.includes(id));
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_expiry_sweeps_test');
    // Windows cannot spawn npx.cmd directly through execFileSync (EINVAL).
    const isWindows = process.platform === 'win32';
    execFileSync(isWindows ? 'cmd.exe' : 'npx', isWindows ? ['/c', 'npx', 'prisma', 'migrate', 'deploy'] : ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    process.env.DATABASE_URL = databaseUrl;

    ({ prisma } = await import('../../src/db/prisma-client.js'));
    ({ expireUnconfirmedOrders } = await import('../../src/jobs/order-expiry.js'));
    ({ runExpireUnfulfilledOrders } = await import('../../src/jobs/lab-order-expiry.js'));

    const patientUser = await prisma.user.create({
      data: { email: `sweep-patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient', emailVerifiedAt: new Date() },
    });
    ({ id: patientProfileId } = await prisma.patientProfile.create({
      data: { userId: patientUser.id, fullName: 'Sweep Patient' },
    }));

    const facilityUser = await prisma.user.create({
      data: { email: `sweep-facility-${runId}@example.com`, passwordHash: 'unused', role: 'facility', emailVerifiedAt: new Date() },
    });
    const facility = await prisma.facilityProfile.create({
      data: { userId: facilityUser.id, name: 'Sweep Facility', type: 'pharmacy' },
    });
    facilityProfileId = facility.id;

    const doctorUser = await prisma.user.create({
      data: { email: `sweep-doctor-${runId}@example.com`, passwordHash: 'unused', role: 'doctor', emailVerifiedAt: new Date() },
    });
    const doctor = await prisma.doctorProfile.create({
      data: { userId: doctorUser.id, fullName: 'Sweep Doctor', timeZone: 'UTC', verificationStatus: 'verified' },
    });
    doctorProfileId = doctor.id;
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('expires every eligible order across batches with exactly one audit event each', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const eligible = await Promise.all(
      Array.from({ length: 7 }, (_, index) => createOrder({ tag: `order-all-${index}`, fulfilledAt: old })),
    );
    const disputed = await createOrder({ tag: 'order-disputed', fulfilledAt: old, disputed: true });
    const confirmed = await createOrder({ tag: 'order-confirmed', fulfilledAt: old, confirmed: true });
    const recent = await createOrder({ tag: 'order-recent', fulfilledAt: new Date() });
    const issued = await createOrder({ tag: 'order-issued', fulfilledAt: old, status: 'issued' });

    const result = await expireUnconfirmedOrders(1, { maxPerRun: 100 });
    expect(result).toMatchObject({ confirmedCount: 7, selectedCount: 7, skippedCount: 0, batches: 3, capHit: false });

    for (const order of eligible) {
      const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated.confirmed).toBe(true);
      expect(updated.confirmationSource).toBe('timeout');
    }
    for (const untouched of [disputed, recent, issued]) {
      expect((await prisma.order.findUniqueOrThrow({ where: { id: untouched.id } })).confirmed).toBe(false);
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: confirmed.id } })).confirmationSource).toBe('patient');

    const eligibleIds = eligible.map((order) => order.id);
    const events = await prisma.auditEvent.findMany({
      where: { action: 'order.receipt_confirmed', entityId: { in: eligibleIds } },
    });
    expect(events).toHaveLength(7);
    expect(new Set(events.map((event) => event.entityId)).size).toBe(7);
  }, 30_000);

  it('stops an order sweep at the configured cap and continues on the next run', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const eligible = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createOrder({ tag: `order-cap-${index}`, fulfilledAt: old })),
    );

    const first = await expireUnconfirmedOrders(1);
    expect(first).toMatchObject({ confirmedCount: 5, selectedCount: 5, batches: 2, capHit: true });
    const second = await expireUnconfirmedOrders(1);
    expect(second).toMatchObject({ confirmedCount: 3, selectedCount: 3, capHit: false });

    const eligibleIds = eligible.map((order) => order.id);
    const events = await prisma.auditEvent.findMany({
      where: { action: 'order.receipt_confirmed', entityId: { in: eligibleIds } },
    });
    expect(events).toHaveLength(8);
  }, 30_000);

  it('does not double-process order rows when two sweeps run at once', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const eligible = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createOrder({ tag: `order-race-${index}`, fulfilledAt: old })),
    );

    const [first, second] = await Promise.all([
      expireUnconfirmedOrders(1, { maxPerRun: 100 }),
      expireUnconfirmedOrders(1, { maxPerRun: 100 }),
    ]);
    expect(first.confirmedCount + second.confirmedCount).toBe(8);

    const eligibleIds = eligible.map((order) => order.id);
    const events = await prisma.auditEvent.findMany({
      where: { action: 'order.receipt_confirmed', entityId: { in: eligibleIds } },
    });
    expect(events).toHaveLength(8);
    expect(new Set(events.map((event) => event.entityId)).size).toBe(8);
  }, 30_000);

  it('expires every eligible lab order across batches and leaves ineligible rows untouched', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const eligible = await Promise.all(
      Array.from({ length: 7 }, (_, index) => createLabOrder({ tag: `lab-all-${index}`, expiresAt: past })),
    );
    const future = await createLabOrder({ tag: 'lab-future', expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    const fulfilled = await createLabOrder({ tag: 'lab-fulfilled', expiresAt: past, status: 'fulfilled' });

    const result = await runExpireUnfulfilledOrders(new Date(), 100);
    expect(result).toMatchObject({ expired: 7, selected: 7, skipped: 0, batches: 3, capHit: false });

    for (const order of eligible) {
      expect((await prisma.labOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('expired');
    }
    expect((await prisma.labOrder.findUniqueOrThrow({ where: { id: future.id } })).status).toBe('issued');
    expect((await prisma.labOrder.findUniqueOrThrow({ where: { id: fulfilled.id } })).status).toBe('fulfilled');

    const eligibleIds = eligible.map((order) => order.id);
    const eventIds = await expiredEventIds(eligibleIds);
    expect(eventIds).toHaveLength(7);
    expect(new Set(eventIds).size).toBe(7);
  }, 30_000);

  it('stops a lab sweep at the configured cap and continues on the next run', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const eligible = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createLabOrder({ tag: `lab-cap-${index}`, expiresAt: past })),
    );

    const first = await runExpireUnfulfilledOrders(new Date());
    expect(first).toMatchObject({ expired: 5, selected: 5, batches: 2, capHit: true });
    const second = await runExpireUnfulfilledOrders(new Date());
    expect(second).toMatchObject({ expired: 3, selected: 3, capHit: false });

    const eventIds = await expiredEventIds(eligible.map((order) => order.id));
    expect(eventIds).toHaveLength(8);
  }, 30_000);

  it('does not double-publish lab events when two sweeps run at once', async () => {
    const past = new Date(Date.now() - 60 * 1000);
    const eligible = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createLabOrder({ tag: `lab-race-${index}`, expiresAt: past })),
    );

    const [first, second] = await Promise.all([
      runExpireUnfulfilledOrders(new Date(), 100),
      runExpireUnfulfilledOrders(new Date(), 100),
    ]);
    expect(first.expired + second.expired).toBe(8);

    const eventIds = await expiredEventIds(eligible.map((order) => order.id));
    expect(eventIds).toHaveLength(8);
    expect(new Set(eventIds).size).toBe(8);
  }, 30_000);
});
