// Referral foundation (issues #5/#7 minimal): creation from a
// consultation, snapshot copy, patient accept (books the referral
// appointment) and decline — plus the creation-time validation gates.
// Self-contained embedded Postgres on port 5445 (see booking.test.mts
// for the why of that pattern). Every integration file needs its OWN port —
// vitest runs them in parallel, and two files on one port means one of them
// fails to start.
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
const PORT = 5445;
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

describe('referral foundation', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let cardiologyId: string;
  let endocrinologyId: string;
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
    cardiologyId = await makeSpecialty(prisma, `Cardiology ${runId}`);
    endocrinologyId = await makeSpecialty(prisma, `Endocrinology ${runId}`);
    doctorA = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardiologyId });
    doctorB = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: endocrinologyId });
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates a referral from a consultation, copying the snapshot', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);

    const res = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      targetSpecialtyId: endocrinologyId,
      snapshotNotes: 'Persistent palpitations, ECG normal.',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.snapshotNotes).toBe('Persistent palpitations, ECG normal.');
    expect(res.body.patientProfileId).toBe(patient.profileId);
    expect(res.body.referringDoctorId).toBe(doctorA.profileId);
    expect(res.body.targetDoctorId).toBe(doctorB.profileId);
    expect(res.body.parentReferralId).toBeNull();
    expect(res.body.loopFlaggedAt).toBeNull();
  });

  it('creates the referral with a referred consultation and preserves its notes snapshot', async () => {
    const slots = await generateSlots(app, doctorA, 2);
    const appointment = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slots[0] });
    expect(appointment.status).toBe(201);
    await request(app)
      .patch(`/appointments/${appointment.body.id}/status`)
      .set('Authorization', `Bearer ${doctorA.accessToken}`)
      .send({ status: 'completed' });

    const consultation = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${doctorA.accessToken}`)
      .send({
        appointmentId: appointment.body.id,
        outcome: 'referred',
        notes: 'Snapshot at referral time',
        targetSpecialtyId: endocrinologyId,
        targetDoctorId: doctorB.profileId,
      });
    expect(consultation.status).toBe(201);
    expect(consultation.body.referrals).toHaveLength(1);
    const referralId = consultation.body.referrals[0].id as string;

    await prisma.consultation.update({
      where: { id: consultation.body.id },
      data: { notes: 'Later consultation annotation' },
    });
    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.snapshotNotes).toBe('Snapshot at referral time');
  });

  it('creates a visible waiting_for_specialist referral when the specialty has no verified doctors', async () => {
    const specialtyId = await makeSpecialty(prisma, `Unstaffed ${runId}`);
    const slots = await generateSlots(app, doctorA, 2);
    const appointment = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slots[0] });
    await request(app)
      .patch(`/appointments/${appointment.body.id}/status`)
      .set('Authorization', `Bearer ${doctorA.accessToken}`)
      .send({ status: 'completed' });
    const consultation = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${doctorA.accessToken}`)
      .send({ appointmentId: appointment.body.id, outcome: 'referred', notes: 'Needs specialist', targetSpecialtyId: specialtyId });

    expect(consultation.status).toBe(201);
    expect(consultation.body.referrals[0]).toMatchObject({
      status: 'waiting_for_specialist',
      targetDoctorId: null,
      targetSpecialtyId: specialtyId,
    });
  });

  it('rejects referral creation that violates the gates', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);

    // unverified target
    const unverified = await makeDoctor(app, prisma, emailedTokens, runId + 1);
    await prisma.doctorProfile.update({
      where: { id: unverified.profileId },
      data: { verificationStatus: 'pending' },
    });
    const unverifiedRes = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: unverified.profileId,
      snapshotNotes: 'notes',
    });
    expect(unverifiedRes.status).toBe(422);

    // self-referral
    const selfRes = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorA.profileId,
      snapshotNotes: 'notes',
    });
    expect(selfRes.status).toBe(422);

    // not the referring doctor's own consultation
    const foreignRes = await createReferral(app, doctorB, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'notes',
    });
    expect(foreignRes.status).toBe(403);

    // missing consultation
    const missingRes = await createReferral(app, doctorA, {
      sourceConsultationId: '00000000-0000-0000-0000-000000000000',
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'notes',
    });
    expect(missingRes.status).toBe(404);
  });

  it('rejects a referral from a not-completed appointment', async () => {
    const slots = await generateSlots(app, doctorA, 2);
    const appointment = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${patient.accessToken}`)
      .send({ availabilitySlotId: slots[1] });
    expect(appointment.status).toBe(201);
    // consultation creation itself refuses a non-completed appointment
    const consult = await request(app)
      .post('/consultations')
      .set('Authorization', `Bearer ${doctorA.accessToken}`)
      .send({ appointmentId: appointment.body.id, outcome: 'referred', targetSpecialtyId: endocrinologyId });
    expect(consult.status).toBe(409);
  });

  it('accepts a referral by booking the target doctor’s slot (no re-intake)', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'Snapshot to survive acceptance.',
    });
    expect(created.status).toBe(201);
    const referralId = created.body.id as string;

    const slots = await generateSlots(app, doctorB, 2);
    const accepted = await acceptReferral(app, patient, referralId, slots[0]);
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.resultingAppointmentId).toBeTruthy();
    expect(accepted.body.snapshotNotes).toBe('Snapshot to survive acceptance.');

    const appointment = await prisma.appointment.findUniqueOrThrow({
      where: { id: accepted.body.resultingAppointmentId },
    });
    expect(appointment.origin).toBe('referral');
    expect(appointment.referralId).toBe(referralId);
    expect(appointment.doctorProfileId).toBe(doctorB.profileId);
    expect(appointment.patientProfileId).toBe(patient.profileId);
  });

  it('rejects accepting with a slot that is not the target doctor’s', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'notes',
    });
    const foreignSlots = await generateSlots(app, doctorA, 1);
    const res = await acceptReferral(app, patient, created.body.id, foreignSlots[0]);
    expect(res.status).toBe(409);
  });

  it('refuses an accept whose slot was already booked, and leaves the referral pending', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'Slot taken first.',
    });
    expect(created.status).toBe(201);
    const referralId = created.body.id as string;

    // Another booking took this slot first. Setup only: the accept below must
    // go through claimOpenSlot and refuse it, not write an appointment itself.
    const [slotId] = await generateSlots(app, doctorB, 1);
    await prisma.availabilitySlot.update({ where: { id: slotId }, data: { status: 'booked' } });

    const res = await acceptReferral(app, patient, referralId, slotId);
    expect(res.status).toBe(409);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe('pending');
    expect(referral.resultingAppointmentId).toBeNull();
    expect(await prisma.appointment.count({ where: { referralId } })).toBe(0);
  });

  it('rejects accept by the wrong patient and double-accept', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'notes',
    });
    const otherPatient = await makePatient(app, emailedTokens, runId + 1);
    const wrongPatient = await acceptReferral(app, otherPatient, created.body.id, 'some-slot');
    expect(wrongPatient.status).toBe(403);

    const slots = await generateSlots(app, doctorB, 2);
    const first = await acceptReferral(app, patient, created.body.id, slots[0]);
    expect(first.status).toBe(200);
    const second = await acceptReferral(app, patient, created.body.id, slots[1]);
    expect(second.status).toBe(409);
  });

  // The accept path's concurrency guarantee is the same shape as
  // booking's: the conditional `pending → accepted` UPDATE is the only
  // thing standing between a referral and two appointments. Proven here
  // against a real Postgres with genuinely concurrent requests, the same
  // way booking.test.mts proves claimOpenSlot.
  it('lets exactly one of 8 concurrent accepts win', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'Race me.',
    });
    expect(created.status).toBe(201);
    const referralId = created.body.id as string;

    // generateSlots returns every open slot for the day; only 8 of them
    // are needed (and 24 concurrent transactions would just make the
    // assertion noisier, not stronger).
    const slots = (await generateSlots(app, doctorB)).slice(0, 8);
    const results = await Promise.all(
      slots.map((slotId) => acceptReferral(app, patient, referralId, slotId)),
    );

    const winners = results.filter((res) => res.status === 200);
    const losers = results.filter((res) => res.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);

    const appointments = await prisma.appointment.findMany({ where: { referralId } });
    expect(appointments).toHaveLength(1);
    expect(winners[0].body.resultingAppointmentId).toBe(appointments[0].id);

    const referral = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(referral.status).toBe('accepted');
    expect(referral.resultingAppointmentId).toBe(appointments[0].id);

    // Every slot a losing accept aimed at must still be open — a losing
    // accept must not consume calendar.
    const slotRows = await prisma.availabilitySlot.findMany({ where: { id: { in: slots } } });
    expect(slotRows.filter((slot) => slot.status === 'booked')).toHaveLength(1);
    expect(slotRows.filter((slot) => slot.status === 'open')).toHaveLength(7);
  });

  it('declines a pending referral; decline is pending-only', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'notes',
    });
    const declined = await request(app)
      .post(`/referrals/${created.body.id}/decline`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('declined');

    const again = await request(app)
      .post(`/referrals/${created.body.id}/decline`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(again.status).toBe(409);
  });

  // The patient's accept/decline and the appointment the accept produces
  // are state changes on accountable records, so both belong in the audit
  // trail (Phase 8, issue #43) — the referral accept path used to be the
  // one way to create an appointment with no trail at all. Asserted
  // against the one AuditEvent table, written by the audit module's
  // service, not by the referrals module touching the table.
  it('audits the accept: the referral transition and the appointment it booked', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'audited snapshot',
    });
    expect(created.status).toBe(201);
    const referralId = created.body.id as string;

    const slots = await generateSlots(app, doctorB, 2);
    const accepted = await acceptReferral(app, patient, referralId, slots[0]);
    expect(accepted.status).toBe(200);
    const appointmentId = accepted.body.resultingAppointmentId as string;

    const referralEvents = await prisma.auditEvent.findMany({
      where: { entityType: 'Referral', entityId: referralId },
    });
    const acceptedEvent = referralEvents.find((event) => event.action === 'referral.accepted');
    expect(acceptedEvent).toBeDefined();
    expect(acceptedEvent?.fromState).toBe('pending');
    expect(acceptedEvent?.toState).toBe('accepted');
    expect(acceptedEvent?.actorUserId).toBe(patient.userId);
    expect(acceptedEvent?.actorRole).toBe('patient');

    // The appointment the accept booked is audited too, as an
    // appointment — with `origin: 'referral'`, which is what tells the
    // two booking paths apart in the trail.
    const appointmentEvents = await prisma.auditEvent.findMany({
      where: { entityType: 'Appointment', entityId: appointmentId },
    });
    const bookedEvent = appointmentEvents.find((event) => event.action === 'appointment.booked');
    expect(bookedEvent).toBeDefined();
    expect(bookedEvent?.toState).toBe('scheduled');
    expect(bookedEvent?.actorUserId).toBe(patient.userId);
    expect((bookedEvent?.metadata as { origin?: string } | null)?.origin).toBe('referral');
  });

  it('audits the decline', async () => {
    const { consultationId } = await consultationRitual(app, patient, doctorA);
    const created = await createReferral(app, doctorA, {
      sourceConsultationId: consultationId,
      targetDoctorId: doctorB.profileId,
      snapshotNotes: 'notes',
    });
    const declined = await request(app)
      .post(`/referrals/${created.body.id}/decline`)
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(declined.status).toBe(200);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'Referral', entityId: created.body.id as string },
    });
    const declinedEvent = events.find((event) => event.action === 'referral.declined');
    expect(declinedEvent).toBeDefined();
    expect(declinedEvent?.fromState).toBe('pending');
    expect(declinedEvent?.toState).toBe('declined');
    expect(declinedEvent?.actorUserId).toBe(patient.userId);
  });

  it('lists the patient’s referrals grouped by source consultation', async () => {
    const list = await request(app)
      .get('/referrals/mine')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.referrals.length).toBeGreaterThan(0);
    const groups = list.body.groupedByConsultation as Record<string, unknown[]>;
    expect(Object.keys(groups).length).toBeGreaterThan(0);
  });
});
