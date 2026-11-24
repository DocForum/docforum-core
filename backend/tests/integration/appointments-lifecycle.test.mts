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
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (_err) {
      void _err;
    }
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

  describe('appointments reschedule (issue #293)', () => {
    it('succeeds for far-future slot and releases the old slot', async () => {
      const oldSlotStart = new Date(Date.now() + 48 * 3600 * 1000);
      const newSlotStart = new Date(Date.now() + 72 * 3600 * 1000);
      const [oldSlot, newSlot] = await Promise.all([
        prisma.availabilitySlot.create({
          data: {
            doctorProfileId: doctorA.profileId,
            startTime: oldSlotStart,
            endTime: new Date(oldSlotStart.getTime() + 30 * 60 * 1000),
            status: 'open',
          },
        }),
        prisma.availabilitySlot.create({
          data: {
            doctorProfileId: doctorA.profileId,
            startTime: newSlotStart,
            endTime: new Date(newSlotStart.getTime() + 30 * 60 * 1000),
            status: 'open',
          },
        }),
      ]);

      const bookRes = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ availabilitySlotId: oldSlot.id });
      expect(bookRes.status).toBe(201);
      const appointmentId = bookRes.body.id;

      const rescheduleRes = await request(app)
        .post(`/appointments/${appointmentId}/reschedule`)
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ newSlotId: newSlot.id });
      expect(rescheduleRes.status).toBe(200);
      expect(rescheduleRes.body.availabilitySlotId).toBe(newSlot.id);

      const oldSlotAfter = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: oldSlot.id } });
      expect(oldSlotAfter.status).toBe('open');
      const newSlotAfter = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: newSlot.id } });
      expect(newSlotAfter.status).toBe('booked');
    });

    it('rejects reschedule within cutoff with 409', async () => {
      // Current slot is 30m away (within 2h cutoff)
      const oldSlotStart = new Date(Date.now() + 30 * 60 * 1000);
      const newSlotStart = new Date(Date.now() + 48 * 3600 * 1000);
      const [oldSlot, newSlot] = await Promise.all([
        prisma.availabilitySlot.create({
          data: {
            doctorProfileId: doctorA.profileId,
            startTime: oldSlotStart,
            endTime: new Date(oldSlotStart.getTime() + 30 * 60 * 1000),
            status: 'open',
          },
        }),
        prisma.availabilitySlot.create({
          data: {
            doctorProfileId: doctorA.profileId,
            startTime: newSlotStart,
            endTime: new Date(newSlotStart.getTime() + 30 * 60 * 1000),
            status: 'open',
          },
        }),
      ]);

      const bookRes = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ availabilitySlotId: oldSlot.id });
      expect(bookRes.status).toBe(201);
      const appointmentId = bookRes.body.id;

      const rescheduleRes = await request(app)
        .post(`/appointments/${appointmentId}/reschedule`)
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ newSlotId: newSlot.id });
      expect(rescheduleRes.status).toBe(409);
    });

    it('rescheduling onto the same slot is a no-op', async () => {
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

      const rescheduleRes = await request(app)
        .post(`/appointments/${appointmentId}/reschedule`)
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ newSlotId: slot.id });
      expect(rescheduleRes.status).toBe(200);
      expect(rescheduleRes.body.id).toBe(appointmentId);
    });

    it('refuses to reschedule to a slot of a different doctor with 400', async () => {
      const slotStart1 = new Date(Date.now() + 48 * 3600 * 1000);
      const slotStart2 = new Date(Date.now() + 72 * 3600 * 1000);
      const [slotDocA, slotDocB] = await Promise.all([
        prisma.availabilitySlot.create({
          data: {
            doctorProfileId: doctorA.profileId,
            startTime: slotStart1,
            endTime: new Date(slotStart1.getTime() + 30 * 60 * 1000),
            status: 'open',
          },
        }),
        prisma.availabilitySlot.create({
          data: {
            doctorProfileId: doctorB.profileId,
            startTime: slotStart2,
            endTime: new Date(slotStart2.getTime() + 30 * 60 * 1000),
            status: 'open',
          },
        }),
      ]);

      const bookRes = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ availabilitySlotId: slotDocA.id });
      expect(bookRes.status).toBe(201);
      const appointmentId = bookRes.body.id;

      const rescheduleRes = await request(app)
        .post(`/appointments/${appointmentId}/reschedule`)
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ newSlotId: slotDocB.id });
      expect(rescheduleRes.status).toBe(400);
    });

    it('handles two patients racing to reschedule into the same target slot', async () => {
      const slot1 = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctorA.profileId,
          startTime: new Date(Date.now() + 48 * 3600 * 1000),
          endTime: new Date(Date.now() + 48.5 * 3600 * 1000),
          status: 'open',
        },
      });
      const slot2 = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctorA.profileId,
          startTime: new Date(Date.now() + 50 * 3600 * 1000),
          endTime: new Date(Date.now() + 50.5 * 3600 * 1000),
          status: 'open',
        },
      });
      const targetSlot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctorA.profileId,
          startTime: new Date(Date.now() + 72 * 3600 * 1000),
          endTime: new Date(Date.now() + 72.5 * 3600 * 1000),
          status: 'open',
        },
      });

      const [book1, book2] = await Promise.all([
        request(app).post('/appointments').set('Authorization', `Bearer ${patient1.accessToken}`).send({ availabilitySlotId: slot1.id }),
        request(app).post('/appointments').set('Authorization', `Bearer ${patient2.accessToken}`).send({ availabilitySlotId: slot2.id }),
      ]);
      expect(book1.status).toBe(201);
      expect(book2.status).toBe(201);

      const [reschedule1, reschedule2] = await Promise.all([
        request(app).post(`/appointments/${book1.body.id}/reschedule`).set('Authorization', `Bearer ${patient1.accessToken}`).send({ newSlotId: targetSlot.id }),
        request(app).post(`/appointments/${book2.body.id}/reschedule`).set('Authorization', `Bearer ${patient2.accessToken}`).send({ newSlotId: targetSlot.id }),
      ]);

      const statuses = [reschedule1.status, reschedule2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it('handles a reschedule racing a booking into the same target slot', async () => {
      const slot1 = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctorA.profileId,
          startTime: new Date(Date.now() + 52 * 3600 * 1000),
          endTime: new Date(Date.now() + 52.5 * 3600 * 1000),
          status: 'open',
        },
      });
      const targetSlot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: doctorA.profileId,
          startTime: new Date(Date.now() + 75 * 3600 * 1000),
          endTime: new Date(Date.now() + 75.5 * 3600 * 1000),
          status: 'open',
        },
      });

      const book1 = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ availabilitySlotId: slot1.id });
      expect(book1.status).toBe(201);

      const [rescheduleRes, bookRes] = await Promise.all([
        request(app).post(`/appointments/${book1.body.id}/reschedule`).set('Authorization', `Bearer ${patient1.accessToken}`).send({ newSlotId: targetSlot.id }),
        request(app).post('/appointments').set('Authorization', `Bearer ${patient2.accessToken}`).send({ availabilitySlotId: targetSlot.id }),
      ]);

      // Either reschedule won (200) and booking lost (409), OR booking won (201) and reschedule lost (409)
      const won = (rescheduleRes.status === 200 && bookRes.status === 409) || (bookRes.status === 201 && rescheduleRes.status === 409);
      expect(won).toBe(true);
    });
  });

  describe('waitlist leave (issue #294)', () => {
    it('allows patient to leave their own pending waitlist entry', async () => {
      const entry = await prisma.waitlistEntry.create({
        data: {
          patientProfileId: patient1.profileId,
          doctorProfileId: doctorA.profileId,
          status: 'pending',
          earliestAcceptable: new Date(),
          latestAcceptable: new Date(Date.now() + 86400000),
          holdDurationMinutes: 30,
        },
      });

      const res = await request(app)
        .post('/appointments/waitlist/leave')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ entryId: entry.id });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: true });

      const updated = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(updated.status).toBe('expired');
    });

    it('rejects attempt to leave another patients waitlist entry with 403', async () => {
      const entry = await prisma.waitlistEntry.create({
        data: {
          patientProfileId: patient1.profileId,
          doctorProfileId: doctorA.profileId,
          status: 'pending',
          earliestAcceptable: new Date(),
          latestAcceptable: new Date(Date.now() + 86400000),
          holdDurationMinutes: 30,
        },
      });

      const res = await request(app)
        .post('/appointments/waitlist/leave')
        .set('Authorization', `Bearer ${patient2.accessToken}`)
        .send({ entryId: entry.id });
      expect(res.status).toBe(403);
    });

    it('rejects attempt to leave an already accepted waitlist entry with 409', async () => {
      const entry = await prisma.waitlistEntry.create({
        data: {
          patientProfileId: patient1.profileId,
          doctorProfileId: doctorA.profileId,
          status: 'accepted',
          earliestAcceptable: new Date(),
          latestAcceptable: new Date(Date.now() + 86400000),
          holdDurationMinutes: 30,
        },
      });

      const res = await request(app)
        .post('/appointments/waitlist/leave')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ entryId: entry.id });
      expect(res.status).toBe(409);
    });

    it('rejects attempt to leave an already expired waitlist entry with 409', async () => {
      const entry = await prisma.waitlistEntry.create({
        data: {
          patientProfileId: patient1.profileId,
          doctorProfileId: doctorA.profileId,
          status: 'expired',
          earliestAcceptable: new Date(),
          latestAcceptable: new Date(Date.now() + 86400000),
          holdDurationMinutes: 30,
        },
      });

      const res = await request(app)
        .post('/appointments/waitlist/leave')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ entryId: entry.id });
      expect(res.status).toBe(409);
    });

    it('allows a guardian to leave a waitlist entry on behalf of their dependent', async () => {
      const depRes = await request(app)
        .post('/patients/me/dependents')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ fullName: 'Dependent Child', dateOfBirth: '2020-01-01' });
      expect(depRes.status).toBe(201);
      const dependentProfileId = depRes.body.id;

      const entry = await prisma.waitlistEntry.create({
        data: {
          patientProfileId: dependentProfileId,
          doctorProfileId: doctorA.profileId,
          status: 'pending',
          earliestAcceptable: new Date(),
          latestAcceptable: new Date(Date.now() + 86400000),
          holdDurationMinutes: 30,
        },
      });

      const res = await request(app)
        .post('/appointments/waitlist/leave')
        .set('Authorization', `Bearer ${patient1.accessToken}`)
        .send({ entryId: entry.id });
      expect(res.status).toBe(200);

      const updated = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(updated.status).toBe('expired');
    });
  });
});
