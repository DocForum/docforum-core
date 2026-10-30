import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5443;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-outbox-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type EventService = typeof import('../../src/events/index.js');

describe('transactional outbox', () => {
  let prisma: Prisma;
  let events: EventService;
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let appointments: typeof import('../../src/modules/appointments/services/index.js');
  let patientUserId: string;
  let doctorProfileId: string;
  let adminToken: string;
  let patientToken: string;
  let slotSequence = 0;

  async function publishBookingEvent(appointmentId: string) {
    return prisma.$transaction((tx) =>
      events.publish(tx, 'appointment.booked', { appointmentId, patientUserId }),
    );
  }

  async function createSlot() {
    slotSequence += 1;
    return prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        startTime: new Date(Date.now() + (60 + slotSequence) * 60 * 1000),
        endTime: new Date(Date.now() + (90 + slotSequence) * 60 * 1000),
      },
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    const dbModule = await import('../../src/db/prisma-client.js');
    events = await import('../../src/events/index.js');
    appointments = await import('../../src/modules/appointments/services/index.js');
    const appModule = await import('../../src/app.js');
    prisma = dbModule.prisma;
    app = appModule.createApp();

    const patientUser = await prisma.user.create({
      data: { email: `outbox-patient-${runId}@example.com`, passwordHash: 'unused', role: 'patient' },
    });
    patientUserId = patientUser.id;
    await prisma.patientProfile.create({ data: { userId: patientUserId, fullName: 'Outbox Patient' } });
    const doctorUser = await prisma.user.create({
      data: { email: `outbox-doctor-${runId}@example.com`, passwordHash: 'unused', role: 'doctor' },
    });
    doctorProfileId = (await prisma.doctorProfile.create({ data: { userId: doctorUser.id, fullName: 'Outbox Doctor' } })).id;

    const admin = await prisma.user.create({
      data: { email: `outbox-admin-${runId}@example.com`, passwordHash: 'unused', role: 'admin' },
    });
    adminToken = jwt.sign({ sub: admin.id, role: 'admin' }, 'test-access-secret', { expiresIn: '15m' });
    patientToken = jwt.sign({ sub: patientUserId, role: 'patient' }, 'test-access-secret', { expiresIn: '15m' });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('commits the booking event with the booking and rolls both back on event failure', async () => {
    const slot = await createSlot();
    const booking = await appointments.bookSlot(
      { userId: patientUserId, role: 'patient', requestId: `outbox-${runId}` },
      slot.id,
    );
    const eventsForBooking = await prisma.outboxEvent.findMany({
      where: { type: 'appointment.booked', payload: { path: ['appointmentId'], equals: booking.id } },
    });
    expect(eventsForBooking).toHaveLength(1);
    expect(eventsForBooking[0]?.status).toBe('pending');
    await prisma.outboxEvent.delete({ where: { id: eventsForBooking[0]!.id } });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected outbox failure'; END; $$`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER fail_outbox_insert BEFORE INSERT ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION fail_outbox_insert()',
    );
    const rollbackSlot = await createSlot();
    const eventCountBeforeRollback = await prisma.outboxEvent.count();
    await expect(
      appointments.bookSlot(
        { userId: patientUserId, role: 'patient', requestId: `outbox-rollback-${runId}` },
        rollbackSlot.id,
      ),
    ).rejects.toThrow();
    await prisma.$executeRawUnsafe('DROP TRIGGER fail_outbox_insert ON "OutboxEvent"');
    await prisma.$executeRawUnsafe('DROP FUNCTION fail_outbox_insert()');

    expect(await prisma.appointment.count({ where: { availabilitySlotId: rollbackSlot.id } })).toBe(0);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: rollbackSlot.id } })).status).toBe('open');
    expect(await prisma.outboxEvent.count()).toBe(eventCountBeforeRollback);
  });

  it('delivers a persisted event after delayed dispatch and deduplicates notification delivery', async () => {
    const appointmentId = '00000000-0000-4000-8000-000000000101';
    const event = await publishBookingEvent(appointmentId);
    expect(event.status).toBe('pending');

    const jobs = await import('../../src/jobs/outbox-events.js');
    const { registerDomainEventHandlers } = await import('../../src/events/handlers.js');
    const unregister = registerDomainEventHandlers();
    try {
      expect(await jobs.dispatchOutboxOnce()).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
      expect(await prisma.notification.count({ where: { sourceEventId: event.id } })).toBe(1);

      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'pending', processedAt: null } });
      expect(await jobs.dispatchOutboxOnce()).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
      expect(await prisma.notification.count({ where: { sourceEventId: event.id } })).toBe(1);
    } finally {
      unregister();
    }
  });

  it('does not concurrently claim an event already being handled', async () => {
    const event = await publishBookingEvent('00000000-0000-4000-8000-000000000102');
    let enteredHandler!: () => void;
    let releaseHandler!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { enteredHandler = resolve; });
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const unregister = events.registerHandler('appointment.booked', async () => {
      enteredHandler();
      await handlerGate;
    });
    try {
      const jobs = await import('../../src/jobs/outbox-events.js');
      const first = jobs.dispatchOutboxOnce();
      await handlerEntered;
      expect(await jobs.dispatchOutboxOnce()).toMatchObject({ claimed: 0, processed: 0, failed: 0 });
      releaseHandler();
      expect(await first).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
      expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('processed');
    } finally {
      releaseHandler();
      unregister();
    }
  });

  it('dead-letters exhausted handlers and exposes sanitized metadata only to admins', async () => {
    const event = await publishBookingEvent('00000000-0000-4000-8000-000000000103');
    const retryEvent = await publishBookingEvent('00000000-0000-4000-8000-000000000104');
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { attempts: 4 } });
    const unregister = events.registerHandler('appointment.booked', async () => { throw new Error('sensitive provider details'); });
    try {
      const jobs = await import('../../src/jobs/outbox-events.js');
      expect(await jobs.dispatchOutboxOnce()).toMatchObject({ claimed: 2, processed: 0, failed: 2 });
    } finally {
      unregister();
    }

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row).toMatchObject({ status: 'dead', attempts: 5, lastError: 'HANDLER_FAILED' });
    expect(row.lastError).not.toContain('sensitive');
    const retry = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: retryEvent.id } });
    expect(retry).toMatchObject({ status: 'pending', attempts: 1, lastError: 'HANDLER_FAILED' });
    expect(retry.availableAt.getTime()).toBeGreaterThan(Date.now());

    const denied = await request(app).get('/admin/outbox/dead-letters').set('Authorization', `Bearer ${patientToken}`);
    expect(denied.status).toBe(403);
    const visible = await request(app).get('/admin/outbox/dead-letters').set('Authorization', `Bearer ${adminToken}`);
    expect(visible.status).toBe(200);
    expect(visible.body.items).toContainEqual(expect.objectContaining({ id: event.id, lastError: 'HANDLER_FAILED' }));
    expect(JSON.stringify(visible.body)).not.toContain('patientUserId');
    expect(JSON.stringify(visible.body)).not.toContain('sensitive provider details');
  });
});