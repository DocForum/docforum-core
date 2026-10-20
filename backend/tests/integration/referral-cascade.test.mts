// Cascade rules (issue #67, PRD §8.2.3): what happens to a referral when
// the appointment it produced is cancelled / no-showed / completed, and
// proof that double-firing the hook is a no-op. Port 5441.
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
  setAppointmentStatus,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5446;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

async function freshAcceptedReferral(
  app: ReturnType<typeof import('../../src/app.js').createApp>,
  doctorA: { accessToken: string; profileId: string },
  doctorB: { accessToken: string; profileId: string },
  patient: { accessToken: string; profileId: string },
) {
  const { consultationId } = await consultationRitual(app, patient as never, doctorA as never);
  const created = await createReferral(app, doctorA, {
    sourceConsultationId: consultationId,
    targetDoctorId: doctorB.profileId,
    snapshotNotes: 'cascade fixture',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const slots = await generateSlots(app, doctorB, 2);
  const accepted = await acceptReferral(app, patient, created.body.id, slots[0]);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  return {
    referralId: created.body.id as string,
    appointmentId: accepted.body.resultingAppointmentId as string,
    remainingSlotId: slots[1] as string,
  };
}

describe('referral cascade on appointment transitions', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let doctorA: Awaited<ReturnType<typeof makeDoctor>>;
  let doctorB: Awaited<ReturnType<typeof makeDoctor>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });
    // Must be set before the app module (and its PrismaClient) loads.
    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    await installEmailCapture(emailedTokens);
    const specialtyId = await makeSpecialty(prisma, `Cardiology ${runId}`);
    doctorA = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    doctorB = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('patient cancellation returns the referral to pending and frees the future slot', async () => {
    const { referralId, appointmentId } = await freshAcceptedReferral(app, doctorA, doctorB, patient);
    const before = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    const slotId = before.availabilitySlotId!;

    const cancelled = await request(app)
      .patch(`/appointments/${appointmentId}/cancel`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(cancelled.status).toBe(200);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe('pending');
    expect(referral.resultingAppointmentId).toBeNull();
    expect(referral.snapshotNotes).toBe('cascade fixture'); // snapshot survives

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(appointment.status).toBe('cancelled');
    expect(appointment.availabilitySlotId).toBeNull(); // unique claim released
    const slot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } });
    expect(slot.status).toBe('open'); // re-bookable, released

    // The cancelled appointment remains part of the referral's history.
    const history = await prisma.appointment.findMany({ where: { referralId } });
    expect(history.map((row) => row.id)).toContain(appointmentId);

    // And the released slot can actually be re-booked (the exact bug the
    // nullable link exists to prevent).
    const rebook = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slotId });
    expect(rebook.status).toBe(201);
  });

  it('first no-show returns the referral to pending with noShowCount=1; second expires it with the referring-doctor flag', async () => {
    const { referralId, appointmentId } = await freshAcceptedReferral(app, doctorA, doctorB, patient);

    const first = await setAppointmentStatus(app, doctorB, appointmentId, 'no_show');
    expect(first.status).toBe(200);
    let referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe('pending');
    expect(referral.noShowCount).toBe(1);
    expect(referral.referringDoctorNotifiedAt).toBeNull();

    // Re-book: accept again (snapshot reused, no re-intake).
    const slots = await generateSlots(app, doctorB, 2);
    const rebooked = await acceptReferral(app, patient, referralId, slots[0]);
    expect(rebooked.status).toBe(200);
    const secondAppointmentId = rebooked.body.resultingAppointmentId as string;

    const second = await setAppointmentStatus(app, doctorB, secondAppointmentId, 'no_show');
    expect(second.status).toBe(200);
    referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe('expired');
    expect(referral.noShowCount).toBe(2);
    expect(referral.referringDoctorNotifiedAt).not.toBeNull();
    // The expiring no-show appointment stays linked as the reason.
    expect(referral.resultingAppointmentId).toBe(secondAppointmentId);
  });

  it('completing the referral-origin appointment completes the referral', async () => {
    const { referralId, appointmentId } = await freshAcceptedReferral(app, doctorA, doctorB, patient);

    const completed = await setAppointmentStatus(app, doctorB, appointmentId, 'completed');
    expect(completed.status).toBe(200);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe('completed');
  });

  it('is idempotent when the transition (and hook) fires twice', async () => {
    const { referralId, appointmentId } = await freshAcceptedReferral(app, doctorA, doctorB, patient);

    const first = await setAppointmentStatus(app, doctorB, appointmentId, 'no_show');
    expect(first.status).toBe(200);
    // Second call: the conditional UPDATE matches nothing → 409, and the
    // cascade must NOT have advanced noShowCount a second time.
    const second = await setAppointmentStatus(app, doctorB, appointmentId, 'no_show');
    expect(second.status).toBe(409);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.noShowCount).toBe(1);
    expect(referral.status).toBe('pending');
  });

  it('direct-booking appointments (no referral) still transition normally', async () => {
    const slots = await generateSlots(app, doctorA, 2);
    const appointment = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slots[0] });
    expect(appointment.status).toBe(201);
    const completed = await setAppointmentStatus(app, doctorA, appointment.body.id, 'completed');
    expect(completed.status).toBe(200);
  });
});
