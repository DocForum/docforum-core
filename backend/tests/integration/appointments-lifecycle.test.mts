import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import {
  acceptReferral,
  consultationRitual,
  createReferral,
  generateSlots,
  installEmailCapture,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5478;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-appointments-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
  initdbFlags: ['-E', 'UTF8'],
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const emailedTokens = new Map<string, string>();

describe('appointments cancellation (issue #292)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  let doctorA: { accessToken: string; profileId: string; userId: string };
  let doctorB: { accessToken: string; profileId: string; userId: string };
  let patient1: { accessToken: string; profileId: string; userId: string };
  let patient2: { accessToken: string; profileId: string; userId: string };
  let specialtyId: string;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');

    execFileSync(process.execPath, [path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    await installEmailCapture(emailedTokens);
    app = appModule.createApp();
    prisma = dbModule.prisma;

    specialtyId = await makeSpecialty(prisma, `Appointments Specialty ${runId}`);
    doctorA = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    doctorB = await makeDoctor(app, prisma, emailedTokens, runId + 1, { specialtyId });
    patient1 = await makePatient(app, emailedTokens, runId);
    patient2 = await makePatient(app, emailedTokens, runId + 1);
  }, 120_000);

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('cancels appointment via POST /:id/cancel, frees the slot, and allows re-booking', async () => {
    const slotStart = new Date(Date.now() + 48 * 3600 * 1000);
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId: doctorA.profileId,
        startTime: slotStart,
        endTime: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: 'open',
      },
    });

    const bookRes = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient1.accessToken}`)
      .send({ availabilitySlotId: slot.id });
    expect(bookRes.status).toBe(201);
    const appointmentId = bookRes.body.id;

    // Cancel via POST /appointments/:id/cancel
    const cancelRes = await request(app)
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${patient1.accessToken}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // Slot is open and appointment slot link is cleared
    const updatedSlot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(updatedSlot.status).toBe('open');
    const updatedApt = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(updatedApt.availabilitySlotId).toBeNull();

    // Patient 2 can now book the freed slot without unique constraint collision
    const rebookRes = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient2.accessToken}`)
      .send({ availabilitySlotId: slot.id });
    expect(rebookRes.status).toBe(201);
  });

  it('refuses to cancel an already completed appointment with 409', async () => {
    const slotStart = new Date(Date.now() - 2 * 3600 * 1000);
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId: doctorA.profileId,
        startTime: slotStart,
        endTime: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: 'booked',
      },
    });

    const appointment = await prisma.appointment.create({
      data: {
        doctorProfileId: doctorA.profileId,
        patientProfileId: patient1.profileId,
        availabilitySlotId: slot.id,
        status: 'completed',
      },
    });

    const cancelRes = await request(app)
      .post(`/appointments/${appointment.id}/cancel`)
      .set('Authorization', `Bearer ${patient1.accessToken}`);
    expect(cancelRes.status).toBe(409);
  });

  it('triggers referral cascade when referral-origin appointment is cancelled', async () => {
    const { consultationId } = await consultationRitual(app, patient1 as never, doctorA as never);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'cancel test notes',
    });
    expect(created.status).toBe(201);
    const referralId = created.body.id;

    const slots = await generateSlots(app, doctorB, 1);
    const accepted = await acceptReferral(app, patient1, referralId, slots[0]);
    expect(accepted.status).toBe(200);
    const appointmentId = accepted.body.resultingAppointmentId;

    const cancelRes = await request(app)
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${patient1.accessToken}`);
    expect(cancelRes.status).toBe(200);

    const refAfter = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(refAfter.status).toBe('pending');
    expect(refAfter.resultingAppointmentId).toBeNull();
  });

  it('marks appointment late_cancelled and keeps slot booked when cancelling within cutoff', async () => {
    // 30 minutes from now (cutoff is 2 hours)
    const slotStart = new Date(Date.now() + 30 * 60 * 1000);
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId: doctorA.profileId,
        startTime: slotStart,
        endTime: new Date(slotStart.getTime() + 30 * 60 * 1000),
        status: 'open',
      },
    });

    const bookRes = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient1.accessToken}`)
      .send({ availabilitySlotId: slot.id });
    expect(bookRes.status).toBe(201);
    const appointmentId = bookRes.body.id;

    const cancelRes = await request(app)
      .post(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${patient1.accessToken}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('late_cancelled');

    const slotAfter = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot.id } });
    expect(slotAfter.status).toBe('booked');
    const aptAfter = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(aptAfter.availabilitySlotId).toBe(slot.id);
  });
});
