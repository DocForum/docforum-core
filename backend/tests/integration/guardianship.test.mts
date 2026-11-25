// Integration tests for guardians and dependents (Phase 8, issue #42,
// docs/adr/0011): creating and listing dependents, booking on a
// dependent's behalf, refusing someone else's dependent before anything is
// booked, revocation and age of majority, the DB constraints, the
// migration's data-preservation guard — and the booking concurrency
// guarantee re-proven with a guardian booking in the race. Self-contained,
// same embedded-Postgres pattern as booking.test.mts. Own port (5454).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { createOrderFixture } from './order-fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, 'prisma', 'migrations');
const PORT = 5454;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-guardian-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: true,
  initdbFlags: ['--encoding=UTF8'],
});
const urlFor = (db: string) => `postgresql://docforum:docforum@localhost:${PORT}/${db}`;
const databaseUrl = urlFor('docforum_test');

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

interface Patient {
  email: string;
  userId: string;
  profileId: string;
  token: string;
}

const emailedTokens = new Map<string, string>();

function yearsAgo(years: number, days = 0): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() - days));
  return d.toISOString().slice(0, 10);
}

const PRISMA_CLI = path.join(BACKEND_ROOT, 'node_modules/prisma/build/index.js');

// Prisma 7 (ADR 0006) dropped `db execute --url`: the CLI reads the URL from
// prisma.config.ts, i.e. from DATABASE_URL, so the target goes in the env.
function dbExecute(url: string, sql: string) {
  execFileSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--stdin'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function dbExecuteFile(url: string, file: string) {
  execFileSync(process.execPath, [PRISMA_CLI, 'db', 'execute', '--file', file], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describe('guardian and dependent profiles', () => {
  let app: App;
  let prisma: Prisma;
  let doctorToken: string;
  let doctorProfileId: string;
  let specialistToken: string;
  let specialistProfileId: string;
  let facilityToken: string;
  let facilityProfileId: string;
  let signAccessToken: typeof import('../../src/modules/auth/services/tokens.js').signAccessToken;
  let g1: Patient; // guardian with dependents
  let g2: Patient; // another guardian
  let adult: Patient; // ordinary patient, no dependents
  let unverified: Patient;
  let d1: string; // g1's dependent
  let d2: string; // g2's dependent
  let d1AppointmentId: string;
  const freeSlots: string[] = [];
  const specialistSlots: string[] = [];
  const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('guardian lab result')]);

  async function signup(role: 'patient' | 'doctor', label: string, verify = true) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app).post('/auth/signup').send({ role, email, password: 'longenough123', fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    if (verify) expect((await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) })).status).toBe(200);
    return { email, userId: res.body.user.id as string, token: res.body.accessToken as string };
  }

  async function signupPatient(label: string, verify = true): Promise<Patient> {
    const user = await signup('patient', label, verify);
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: user.userId } });
    return { ...user, profileId: profile.id };
  }

  const auth = (p: { token: string }) => ({ Authorization: `Bearer ${p.token}` });
  const createDependent = (p: Patient, body: object) => request(app).post('/patients/me/dependents').set(auth(p)).send(body);
  const book = (p: Patient, body: object) => request(app).post('/appointments').set(auth(p)).send(body);
  const nextSlot = () => {
    const slot = freeSlots.shift();
    if (!slot) throw new Error('test ran out of slots');
    return slot;
  };

  /** Book → complete → close → refer, all over HTTP, for the dependent. */
  async function setupClinicalRecords(dependentProfileId: string, label: string) {
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        startTime: new Date(Date.now() - 3600_000),
        endTime: new Date(Date.now() - 1800_000),
        status: 'open',
      },
    });
    const booked = await book(g1, { availabilitySlotId: slot.id, patientProfileId: dependentProfileId });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const appointmentId = booked.body.id as string;

    const completed = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set(auth({ token: doctorToken }))
      .send({ status: 'completed' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const note = `Consultation note for ${label}`;
    const closed = await request(app)
      .post(`/appointments/${appointmentId}/consultation`)
      .set(auth({ token: doctorToken }))
      .send({ outcome: 'referred', notes: note });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    const consultationId = closed.body.consultation.id as string;

    const referred = await request(app)
      .post('/referrals')
      .set(auth({ token: doctorToken }))
      .send({
        sourceConsultationId: consultationId,
        targetDoctorId: specialistProfileId,
        snapshotNotes: `Referral note for ${label}`,
      });
    expect(referred.status, JSON.stringify(referred.body)).toBe(201);
    return { appointmentId, consultationId, referralId: referred.body.id as string, note };
  }

  async function setupLabResult(dependentProfileId: string, label: string) {
    const order = await createOrderFixture(prisma as never, {
      patientProfileId: dependentProfileId,
      facilityProfileId,
      kind: 'lab_order',
      amountStroops: 10_000_000n,
      tag: `guardian-read-${label}-${runId}`,
    });
    const attached = await request(app)
      .post(`/orders/lab-orders/${order.id}/result`)
      .set(auth({ token: facilityToken }))
      .set('Content-Type', 'application/pdf')
      .send(PDF);
    expect(attached.status, JSON.stringify(attached.body)).toBe(201);
    return { labOrderId: order.id, resultId: attached.body.id as string };
  }

  /** recordAccess is fire-and-forget; poll briefly instead of racing it. */
  async function waitForAccessLogs(entityType: string, entityId: string, accessedBy: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await prisma.accessLog.findMany({
        where: { entityType: entityType as never, entityId, accessedBy },
      });
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return prisma.accessLog.findMany({ where: { entityType: entityType as never, entityId, accessedBy } });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_test');
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    process.env.DATABASE_URL = databaseUrl;
    process.env.AGE_OF_MAJORITY_YEARS = '18';

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    const tokens = await import('../../src/modules/auth/services/tokens.js');
    signAccessToken = tokens.signAccessToken;
    app = appModule.createApp();
    prisma = dbModule.prisma;
    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const doctor = await signup('doctor', 'guardian-doctor');
    doctorToken = doctor.token;
    doctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctor.userId } })).id;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const generated = await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ date: tomorrow, startHour: 8, endHour: 18, slotLengthMinutes: 30 });
    expect(generated.status).toBe(201);
    freeSlots.push(...((await request(app).get(`/availability/doctors/${doctorProfileId}/slots`)).body as { id: string }[]).map((s) => s.id));

    // Issue #305: a second doctor to receive referrals, and a lab to attach
    // dependent results. Both are needed to exercise the four read/act paths
    // over HTTP rather than by writing the records straight into the DB.
    const specialist = await signup('doctor', 'guardian-specialist');
    specialistToken = specialist.token;
    const specialistProfile = await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: specialist.userId } });
    specialistProfileId = specialistProfile.id;
    await prisma.doctorProfile.update({
      where: { id: specialistProfileId },
      data: { verificationStatus: 'verified' },
    });
    const specialistGeneration = await request(app)
      .post(`/availability/doctors/${specialistProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ date: tomorrow, startHour: 8, endHour: 18, slotLengthMinutes: 30 });
    expect(specialistGeneration.status).toBe(201);
    specialistSlots.push(
      ...((await request(app).get(`/availability/doctors/${specialistProfileId}/slots`)).body as { id: string }[]).map((s) => s.id),
    );

    const labUser = await prisma.user.create({
      data: {
        email: `guardian-lab-${runId}@example.com`,
        passwordHash: 'unused',
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    facilityToken = signAccessToken({ sub: labUser.id, role: 'facility' });
    facilityProfileId = (
      await prisma.facilityProfile.create({
        data: { userId: labUser.id, name: 'Guardian Test Lab', type: 'lab' },
      })
    ).id;

    g1 = await signupPatient('guardian-one');
    g2 = await signupPatient('guardian-two');
    adult = await signupPatient('adult');
    unverified = await signupPatient('unverified', false);
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Ignore temporary folder EBUSY cleanup on Windows
    }
  });

  it('lets a patient create a dependent: a login-less profile plus a guardianship', async () => {
    const res = await createDependent(g1, { fullName: 'Child One', dateOfBirth: yearsAgo(6) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fullName: 'Child One', dateOfBirth: `${yearsAgo(6)}T00:00:00.000Z` });
    expect(Object.keys(res.body).sort()).toEqual(['dateOfBirth', 'fullName', 'guardianSince', 'id']);
    d1 = res.body.id;

    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { id: d1 } });
    expect(profile.userId).toBeNull();
    const guardianships = await prisma.guardianship.findMany({ where: { dependentProfileId: d1 } });
    expect(guardianships).toEqual([expect.objectContaining({ guardianUserId: g1.userId, revokedAt: null })]);

    const other = await createDependent(g2, { fullName: 'Child Two', dateOfBirth: yearsAgo(10) });
    expect(other.status).toBe(201);
    d2 = other.body.id;
  });

  it('refuses unauthorised or invalid dependent creation, and never links an existing profile', async () => {
    const before = await prisma.guardianship.count();
    // Linking attempts: naming an existing profile/user is rejected outright.
    for (const extra of [{ patientProfileId: adult.profileId }, { userId: adult.userId }, { patientProfileId: d2 }]) {
      const res = await createDependent(g1, { fullName: 'Sneaky', dateOfBirth: yearsAgo(5), ...extra });
      expect(res.status).toBe(400);
    }
    expect(await prisma.guardianship.count({ where: { dependentProfileId: { in: [adult.profileId, d2] }, guardianUserId: g1.userId } })).toBe(0);

    const adultDob = await createDependent(g1, { fullName: 'Grown Up', dateOfBirth: yearsAgo(18) });
    expect(adultDob.status).toBe(400);
    expect(adultDob.body.code).toBe('DEPENDENT_NOT_A_MINOR');
    expect((await createDependent(g1, { fullName: 'Future', dateOfBirth: '2999-01-01' })).status).toBe(400);
    expect((await createDependent(g1, { fullName: 'Bad', dateOfBirth: '2020-02-30' })).status).toBe(400);
    expect((await createDependent(g1, { dateOfBirth: yearsAgo(3) })).status).toBe(400);

    const doctor = await request(app).post('/patients/me/dependents').set('Authorization', `Bearer ${doctorToken}`).send({ fullName: 'X', dateOfBirth: yearsAgo(3) });
    expect(doctor.status).toBe(403);
    const unverifiedRes = await createDependent(unverified, { fullName: 'X', dateOfBirth: yearsAgo(3) });
    expect(unverifiedRes.status).toBe(403);
    expect(unverifiedRes.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await request(app).post('/patients/me/dependents').send({ fullName: 'X', dateOfBirth: yearsAgo(3) })).status).toBe(401);

    // One day short of majority is still a minor.
    const almost = await createDependent(g1, { fullName: 'Almost Adult', dateOfBirth: yearsAgo(18, -1) });
    expect(almost.status).toBe(201);
    expect(await prisma.guardianship.count()).toBe(before + 1);
  });

  it("lists only the caller's own active dependents", async () => {
    const mine = await request(app).get('/patients/me/dependents').set(auth(g1));
    expect(mine.status).toBe(200);
    expect(mine.body.map((d: { fullName: string }) => d.fullName)).toEqual(['Child One', 'Almost Adult']);
    const theirs = await request(app).get('/patients/me/dependents').set(auth(g2));
    expect(theirs.body.map((d: { id: string }) => d.id)).toEqual([d2]);
    expect((await request(app).get('/patients/me/dependents').set(auth(adult))).body).toEqual([]);
    expect((await request(app).get('/patients/me/dependents').set('Authorization', `Bearer ${doctorToken}`)).status).toBe(403);
  });

  it('lets a guardian book for their dependent and see that appointment', async () => {
    const slot = nextSlot();
    const res = await book(g1, { availabilitySlotId: slot, patientProfileId: d1 });
    expect(res.status).toBe(201);
    expect(res.body.patientProfileId).toBe(d1);
    d1AppointmentId = res.body.id;

    // Audit (issue #43): the guardian is the actor; the event names the
    // dependent's profile the appointment was booked for.
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: 'Appointment', entityId: res.body.id } });
    expect(event).toMatchObject({ actorUserId: g1.userId, actorRole: 'patient', action: 'appointment.booked', toState: 'scheduled' });
    expect(event.metadata).toMatchObject({ patientProfileId: d1, availabilitySlotId: slot });

    const dependentAppointments = await request(app).get(`/appointments/mine?patientProfileId=${d1}`).set(auth(g1));
    expect(dependentAppointments.status).toBe(200);
    expect(dependentAppointments.body.map((a: { id: string }) => a.id)).toEqual([res.body.id]);
    // The guardian's own list is the guardian's own history only.
    const own = await request(app).get('/appointments/mine').set(auth(g1));
    expect(own.body).toEqual([]);
  });

  it("refuses another guardian's dependent, or another patient, before anything is booked", async () => {
    for (const target of [d2, adult.profileId]) {
      const slot = nextSlot();
      const res = await book(g1, { availabilitySlotId: slot, patientProfileId: target });
      expect(res.status).toBe(404);
      // Rejected before the booking ran: the slot is still open, no appointment exists.
      expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('open');
      expect(await prisma.appointment.count({ where: { availabilitySlotId: slot } })).toBe(0);
      freeSlots.unshift(slot);
    }
    expect((await request(app).get(`/appointments/mine?patientProfileId=${d2}`).set(auth(g1))).status).toBe(404);
    expect(await prisma.appointment.count({ where: { patientProfileId: { in: [d2, adult.profileId] } } })).toBe(0);
  });

  it('keeps self-booking working, with or without naming your own profile', async () => {
    const plain = await book(adult, { availabilitySlotId: nextSlot() });
    expect(plain.status).toBe(201);
    expect(plain.body.patientProfileId).toBe(adult.profileId);
    const named = await book(adult, { availabilitySlotId: nextSlot(), patientProfileId: adult.profileId });
    expect(named.status).toBe(201);
    expect(named.body.patientProfileId).toBe(adult.profileId);
    expect((await request(app).get('/appointments/mine').set(auth(adult))).body).toHaveLength(2);
  });

  // --- Issue #305: guardian read access to the care that follows a booking --
  it('lets an active guardian read a dependent’s consultation, referrals and lab result, naming them as viewer in the access log', async () => {
    const child = await createDependent(g1, { fullName: 'Child Read Access', dateOfBirth: yearsAgo(7) });
    expect(child.status).toBe(201);
    const dependentId = child.body.id as string;
    const { consultationId, referralId, note } = await setupClinicalRecords(dependentId, 'read');
    const { labOrderId, resultId } = await setupLabResult(dependentId, 'read');

    const withoutProfile = await request(app).get(`/consultations/${consultationId}`).set(auth(g1));
    expect(withoutProfile.status).toBe(403);
    const withProfile = await request(app)
      .get(`/consultations/${consultationId}?patientProfileId=${dependentId}`)
      .set(auth(g1));
    expect(withProfile.status, JSON.stringify(withProfile.body)).toBe(200);
    expect(withProfile.body.notes).toBe(note);

    const ownReferrals = await request(app).get('/referrals/mine').set(auth(g1));
    expect(ownReferrals.status).toBe(200);
    expect(ownReferrals.body.referrals).toEqual([]);
    const dependentReferrals = await request(app)
      .get(`/referrals/mine?patientProfileId=${dependentId}`)
      .set(auth(g1));
    expect(dependentReferrals.status).toBe(200);
    expect(dependentReferrals.body.referrals.map((r: { id: string }) => r.id)).toEqual([referralId]);

    const ownResult = await request(app).get(`/orders/lab-orders/${labOrderId}/result`).set(auth(g1));
    expect(ownResult.status).toBe(404);
    const dependentResult = await request(app)
      .get(`/orders/lab-orders/${labOrderId}/result?patientProfileId=${dependentId}`)
      .set(auth(g1))
      .buffer(true);
    expect(dependentResult.status).toBe(200);
    expect(dependentResult.headers['content-type']).toBe('application/pdf');
    expect(dependentResult.headers['cache-control']).toBe('no-store');

    // The guardian is the viewer on every newly authorised read, and the
    // record owner is still the dependent.
    for (const [entityType, entityId] of [
      ['Consultation', consultationId],
      ['Referral', referralId],
      ['LabResult', resultId],
    ]) {
      const logs = await waitForAccessLogs(entityType, entityId, g1.userId);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatchObject({ patientProfileId: dependentId, accessedBy: g1.userId });
      expect(logs[0].detail).toContain('guardian');
      expect(logs[0].route).toBeTruthy();
    }

    // No enumeration: another guardian and an ordinary patient get 404 even
    // when they name the dependent explicitly.
    for (const other of [g2, adult]) {
      expect((await request(app).get(`/consultations/${consultationId}?patientProfileId=${dependentId}`).set(auth(other))).status).toBe(404);
      expect((await request(app).get(`/referrals/mine?patientProfileId=${dependentId}`).set(auth(other))).status).toBe(404);
      expect((await request(app).get(`/orders/lab-orders/${labOrderId}/result?patientProfileId=${dependentId}`).set(auth(other))).status).toBe(404);
    }
    expect((await request(app).get(`/consultations/${consultationId}?patientProfileId=not-a-uuid`).set(auth(g1))).status).toBe(400);
  });

  it('lets a guardian accept and decline a dependent’s referral through patientProfileId', async () => {
    const child = await createDependent(g1, { fullName: 'Child Referral Actions', dateOfBirth: yearsAgo(6) });
    expect(child.status).toBe(201);
    const dependentId = child.body.id as string;
    const accepting = await setupClinicalRecords(dependentId, 'accept');
    const slot = specialistSlots.shift();
    if (!slot) throw new Error('test ran out of specialist slots');
    const accepted = await request(app)
      .post(`/referrals/${accepting.referralId}/accept`)
      .set(auth(g1))
      .send({ availabilitySlotId: slot, patientProfileId: dependentId });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    const newAppointment = await prisma.appointment.findUniqueOrThrow({ where: { id: accepted.body.resultingAppointmentId } });
    expect(newAppointment).toMatchObject({ patientProfileId: dependentId, doctorProfileId: specialistProfileId });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Referral', entityId: accepting.referralId, action: 'referral.accepted' },
    });
    expect(audit.actorUserId).toBe(g1.userId);
    expect(audit.metadata).toMatchObject({ patientProfileId: dependentId });

    const declining = await setupClinicalRecords(dependentId, 'decline');
    const declined = await request(app)
      .post(`/referrals/${declining.referralId}/decline`)
      .set(auth(g1))
      .send({ patientProfileId: dependentId });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.status).toBe('declined');

    // Without the dependent's profile, the guardian is acting as themselves
    // and cannot touch either referral.
    expect((await request(app).post(`/referrals/${declining.referralId}/decline`).set(auth(g1)).send()).status).toBe(403);
    const anotherSlot = specialistSlots.shift();
    if (!anotherSlot) throw new Error('test ran out of specialist slots');
    expect((await request(app).post(`/referrals/${declining.referralId}/accept`).set(auth(g1)).send({ availabilitySlotId: anotherSlot })).status).toBe(403);
    specialistSlots.unshift(anotherSlot);
    expect((await request(app).post(`/referrals/${declining.referralId}/decline`).set(auth(g2)).send({ patientProfileId: dependentId })).status).toBe(404);
    expect(await prisma.appointment.count({ where: { patientProfileId: dependentId, origin: 'referral' } })).toBe(1);
  });

  it('ends a guardian’s read and act access at the age of majority', async () => {
    const child = await createDependent(g1, { fullName: 'Child Becoming Adult', dateOfBirth: yearsAgo(9) });
    expect(child.status).toBe(201);
    const dependentId = child.body.id as string;
    const { consultationId, referralId } = await setupClinicalRecords(dependentId, 'majority');
    const { labOrderId } = await setupLabResult(dependentId, 'majority');

    // The dependent turns 18. resolveActingProfile checks the DOB on every
    // request, so access stops without any job or flag being flipped.
    await prisma.patientProfile.update({
      where: { id: dependentId },
      data: { dateOfBirth: new Date(`${yearsAgo(18)}T00:00:00.000Z`) },
    });

    const consultationRead = await request(app)
      .get(`/consultations/${consultationId}?patientProfileId=${dependentId}`)
      .set(auth(g1));
    expect(consultationRead.status).toBe(403);
    expect(consultationRead.body.code).toBe('GUARDIANSHIP_INACTIVE');

    const referralList = await request(app).get(`/referrals/mine?patientProfileId=${dependentId}`).set(auth(g1));
    expect(referralList.status).toBe(403);
    expect(referralList.body.code).toBe('GUARDIANSHIP_INACTIVE');

    const slot = specialistSlots.shift();
    if (!slot) throw new Error('test ran out of specialist slots');
    const accept = await request(app)
      .post(`/referrals/${referralId}/accept`)
      .set(auth(g1))
      .send({ availabilitySlotId: slot, patientProfileId: dependentId });
    expect(accept.status).toBe(403);
    expect(accept.body.code).toBe('GUARDIANSHIP_INACTIVE');
    specialistSlots.unshift(slot);

    const decline = await request(app)
      .post(`/referrals/${referralId}/decline`)
      .set(auth(g1))
      .send({ patientProfileId: dependentId });
    expect(decline.status).toBe(403);
    expect(decline.body.code).toBe('GUARDIANSHIP_INACTIVE');

    const download = await request(app)
      .get(`/orders/lab-orders/${labOrderId}/result?patientProfileId=${dependentId}`)
      .set(auth(g1));
    expect(download.status).toBe(403);
    expect(download.body.code).toBe('GUARDIANSHIP_INACTIVE');

    // The record itself survives the end of access.
    expect(await prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } })).toBeTruthy();
    expect(await prisma.labResult.count({ where: { labOrderId } })).toBe(1);
  });

  it('ends a guardian’s read and act access immediately on revocation', async () => {
    const child = await createDependent(g1, { fullName: 'Child Revoked Reads', dateOfBirth: yearsAgo(5) });
    expect(child.status).toBe(201);
    const dependentId = child.body.id as string;
    const { consultationId, referralId } = await setupClinicalRecords(dependentId, 'revoked');
    const { labOrderId } = await setupLabResult(dependentId, 'revoked');
    await prisma.guardianship.updateMany({
      where: { dependentProfileId: dependentId, guardianUserId: g1.userId },
      data: { revokedAt: new Date() },
    });

    const consultationRead = await request(app)
      .get(`/consultations/${consultationId}?patientProfileId=${dependentId}`)
      .set(auth(g1));
    expect(consultationRead.status).toBe(403);
    expect(consultationRead.body.code).toBe('GUARDIANSHIP_INACTIVE');
    const referralList = await request(app).get(`/referrals/mine?patientProfileId=${dependentId}`).set(auth(g1));
    expect(referralList.status).toBe(403);
    expect(referralList.body.code).toBe('GUARDIANSHIP_INACTIVE');
    const slot = specialistSlots.shift();
    if (!slot) throw new Error('test ran out of specialist slots');
    const accept = await request(app)
      .post(`/referrals/${referralId}/accept`)
      .set(auth(g1))
      .send({ availabilitySlotId: slot, patientProfileId: dependentId });
    expect(accept.status).toBe(403);
    expect(accept.body.code).toBe('GUARDIANSHIP_INACTIVE');
    specialistSlots.unshift(slot);
    const decline = await request(app)
      .post(`/referrals/${referralId}/decline`)
      .set(auth(g1))
      .send({ patientProfileId: dependentId });
    expect(decline.status).toBe(403);
    expect(decline.body.code).toBe('GUARDIANSHIP_INACTIVE');
    const download = await request(app)
      .get(`/orders/lab-orders/${labOrderId}/result?patientProfileId=${dependentId}`)
      .set(auth(g1));
    expect(download.status).toBe(403);
    expect(download.body.code).toBe('GUARDIANSHIP_INACTIVE');
  });

  it('Issue #296: appointment detail endpoint returns ETag, slot times, doctor summary, and enforces role-scoped access', async () => {
    // 1. Adult patient reads own appointment
    const slot = nextSlot();
    const booked = await book(adult, { availabilitySlotId: slot });
    expect(booked.status).toBe(201);
    const appointmentId = booked.body.id;

    const patientRead = await request(app).get(`/appointments/${appointmentId}`).set(auth(adult));
    expect(patientRead.status).toBe(200);
    expect(patientRead.headers.etag).toBe('"1"');
    expect(patientRead.body.id).toBe(appointmentId);
    expect(patientRead.body.origin).toBe('direct_booking');
    expect(patientRead.body.slot).toMatchObject({
      startTime: expect.any(String),
      endTime: expect.any(String),
    });
    expect(patientRead.body.doctor).toMatchObject({
      id: doctorProfileId,
      fullName: expect.any(String),
    });

    // 2. Treating doctor reads the appointment
    const doctorRead = await request(app)
      .get(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${doctorToken}`);
    expect(doctorRead.status).toBe(200);
    expect(doctorRead.headers.etag).toBe('"1"');
    expect(doctorRead.body.id).toBe(appointmentId);

    // 3. Guardian reads dependent's appointment
    const depRes = await createDependent(g1, { fullName: 'Child 296', dateOfBirth: yearsAgo(5) });
    expect(depRes.status).toBe(201);
    const dep296Id = depRes.body.id;

    const depSlot = nextSlot();
    const depBooked = await book(g1, { availabilitySlotId: depSlot, patientProfileId: dep296Id });
    expect(depBooked.status).toBe(201);
    const depApptId = depBooked.body.id;

    const guardianRead = await request(app).get(`/appointments/${depApptId}`).set(auth(g1));
    expect(guardianRead.status).toBe(200);
    expect(guardianRead.headers.etag).toBe('"1"');
    expect(guardianRead.body.id).toBe(depApptId);
    expect(guardianRead.body.patientProfileId).toBe(dep296Id);

    // 4. Non-participant (other patient g2) reading returns 404 (not 403)
    const otherPatientRead = await request(app).get(`/appointments/${appointmentId}`).set(auth(g2));
    expect(otherPatientRead.status).toBe(404);

    // 5. Admin reading returns 404 (non-participant clinical privacy)
    const adminUser = await signup('patient', 'admin-for-296');
    await prisma.user.update({ where: { id: adminUser.userId }, data: { role: 'admin' } });
    await prisma.patientProfile.delete({ where: { userId: adminUser.userId } });
    const adminRead = await request(app)
      .get(`/appointments/${appointmentId}`)
      .set('Authorization', `Bearer ${adminUser.token}`);
    expect(adminRead.status).toBe(404);

    // 6. Check-in and queue endpoints work with getAppointmentDetail
    const queueRes = await request(app).get(`/appointments/${appointmentId}/queue`).set(auth(adult));
    expect(queueRes.status).toBe(200);
    expect(queueRes.body.appointmentId).toBe(appointmentId);

    // 7. Cancelled appointment with released slot returns slot: null
    const cancelRes = await request(app)
      .patch(`/appointments/${appointmentId}/status`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ status: 'cancelled' });
    expect(cancelRes.status).toBe(200);

    const cancelledRead = await request(app).get(`/appointments/${appointmentId}`).set(auth(adult));
    expect(cancelledRead.status).toBe(200);
    expect(cancelledRead.body.status).toBe('cancelled');
    expect(cancelledRead.body.slot).toBeNull();
  });

  it("Issue #297: lets guardians cancel and reschedule a dependent's appointments with audit metadata", async () => {
    // Create a new dependent for 297 so existing test counts are untouched
    const depRes = await createDependent(g1, { fullName: 'Child 297', dateOfBirth: yearsAgo(7) });
    expect(depRes.status).toBe(201);
    const depId = depRes.body.id;

    // 1. Guardian books for dependent
    const slot1 = nextSlot();
    const booked = await book(g1, { availabilitySlotId: slot1, patientProfileId: depId });
    expect(booked.status).toBe(201);
    const apptId = booked.body.id;

    // 2. Guardian reschedules dependent's appointment to slot2
    const slot2 = nextSlot();
    const rescheduleRes = await request(app)
      .post(`/appointments/${apptId}/reschedule`)
      .set(auth(g1))
      .send({ newSlotId: slot2 });
    expect(rescheduleRes.status).toBe(200);
    expect(rescheduleRes.body.availabilitySlotId).toBe(slot2);

    // Verify audit event for reschedule
    const rescheduleEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Appointment', entityId: apptId, action: 'appointment.rescheduled' },
    });
    expect(rescheduleEvent).toMatchObject({
      actorUserId: g1.userId,
      actorRole: 'patient',
    });
    expect(rescheduleEvent.metadata).toMatchObject({
      oldSlotId: slot1,
      newSlotId: slot2,
      patientProfileId: depId,
    });

    // 3. Guardian cancels dependent's appointment (POST /appointments/:id/cancel)
    const cancelRes = await request(app)
      .post(`/appointments/${apptId}/cancel`)
      .set(auth(g1))
      .send();
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // Verify audit event for cancel
    const cancelEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Appointment', entityId: apptId, action: 'appointment.cancelled' },
    });
    expect(cancelEvent).toMatchObject({
      actorUserId: g1.userId,
      actorRole: 'patient',
    });
    expect(cancelEvent.metadata).toMatchObject({
      patientProfileId: depId,
    });

    // 4. Guardian cancels via second route (PATCH /appointments/:appointmentId/cancel)
    const slot3 = nextSlot();
    const booked2 = await book(g1, { availabilitySlotId: slot3, patientProfileId: depId });
    expect(booked2.status).toBe(201);
    const appt2Id = booked2.body.id;

    const cancelMineRes = await request(app)
      .patch(`/appointments/${appt2Id}/cancel`)
      .set(auth(g1));
    expect(cancelMineRes.status).toBe(200);
    expect(cancelMineRes.body.status).toBe('cancelled');

    const cancelMineEvent = await prisma.auditEvent.findFirstOrThrow({
      where: { entityType: 'Appointment', entityId: appt2Id, action: 'appointment.cancelled' },
    });
    expect(cancelMineEvent).toMatchObject({
      actorUserId: g1.userId,
      actorRole: 'patient',
    });
    expect(cancelMineEvent.metadata).toMatchObject({
      patientProfileId: depId,
    });
  });

  it('rejects a missing, empty or unknown patientProfileId cleanly', async () => {
    const slot = nextSlot();
    expect((await book(g1, { availabilitySlotId: slot, patientProfileId: '' })).status).toBe(400);
    expect((await book(g1, { availabilitySlotId: slot, patientProfileId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);
    expect((await book(g1, { patientProfileId: d1 })).status).toBe(400);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('open');
    freeSlots.unshift(slot);
  });

  it('ends access on revocation and at the age of majority, keeping the history', async () => {
    // Revoked guardianship.
    const revokedChild = await createDependent(g1, { fullName: 'Revoked Child', dateOfBirth: yearsAgo(8) });
    await prisma.guardianship.updateMany({ where: { dependentProfileId: revokedChild.body.id }, data: { revokedAt: new Date() } });
    const revokedBooking = await book(g1, { availabilitySlotId: nextSlot(), patientProfileId: revokedChild.body.id });
    expect(revokedBooking.status).toBe(403);
    expect(revokedBooking.body.code).toBe('GUARDIANSHIP_INACTIVE');

    // Reaching majority: D1 (who has an appointment) turns 18.
    await prisma.patientProfile.update({ where: { id: d1 }, data: { dateOfBirth: new Date(`${yearsAgo(18)}T00:00:00.000Z`) } });
    const adultBooking = await book(g1, { availabilitySlotId: nextSlot(), patientProfileId: d1 });
    expect(adultBooking.status).toBe(403);
    expect(adultBooking.body.code).toBe('GUARDIANSHIP_INACTIVE');
    expect((await request(app).get(`/appointments/mine?patientProfileId=${d1}`).set(auth(g1))).status).toBe(403);

    const listed = (await request(app).get('/patients/me/dependents').set(auth(g1))).body.map((d: { id: string }) => d.id);
    expect(listed).not.toContain(d1);
    expect(listed).not.toContain(revokedChild.body.id);

    // Ex-guardian is refused when attempting to reschedule or cancel the adult's appointment
    const adultReschedule = await request(app)
      .post(`/appointments/${d1AppointmentId}/reschedule`)
      .set(auth(g1))
      .send({ newSlotId: nextSlot() });
    expect(adultReschedule.status).toBe(403);
    expect(adultReschedule.body.code).toBe('GUARDIANSHIP_INACTIVE');

    const adultCancel = await request(app)
      .post(`/appointments/${d1AppointmentId}/cancel`)
      .set(auth(g1));
    expect(adultCancel.status).toBe(403);
    expect(adultCancel.body.code).toBe('GUARDIANSHIP_INACTIVE');

    const adultCancelMine = await request(app)
      .patch(`/appointments/${d1AppointmentId}/cancel`)
      .set(auth(g1));
    expect(adultCancelMine.status).toBe(403);
    expect(adultCancelMine.body.code).toBe('GUARDIANSHIP_INACTIVE');

    // Clinical history and the guardianship record are kept, not deleted.
    expect(await prisma.appointment.count({ where: { patientProfileId: d1 } })).toBe(1);
    expect(await prisma.guardianship.count({ where: { dependentProfileId: { in: [d1, revokedChild.body.id] } } })).toBe(2);
  });

  it('enforces the model in the database: unique pair, dependent DOB, RESTRICT', async () => {
    await expect(
      prisma.guardianship.create({ data: { guardianUserId: g2.userId, dependentProfileId: d2 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.patientProfile.create({ data: { userId: null, fullName: 'No DOB' } })).rejects.toThrow(
      /PatientProfile_dependent_has_dob/,
    );
    await expect(prisma.patientProfile.delete({ where: { id: d2 } })).rejects.toThrow(/Guardianship_dependentProfileId_fkey/);
  });

  it('keeps the booking concurrency guarantee with a guardian booking in the race', async () => {
    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => signupPatient(`racer-${i}`)));
    const child = await createDependent(g2, { fullName: 'Race Child', dateOfBirth: yearsAgo(4) });
    expect(child.status).toBe(201);
    const slot = nextSlot();

    const responses = await Promise.all([
      book(g2, { availabilitySlotId: slot, patientProfileId: child.body.id }),
      ...racers.map((racer) => book(racer, { availabilitySlotId: slot })),
    ]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(racers.length);
    expect(await prisma.appointment.count({ where: { availabilitySlotId: slot } })).toBe(1);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slot } })).status).toBe('booked');
  });

  it("revokes a guardian's access when they delete their account, keeping the dependent and the record", async () => {
    const patients = await import('../../src/modules/patients/services/index.js');
    const g3 = await signupPatient('guardian-deleting');
    const created = await createDependent(g3, { fullName: 'Kept Child', dateOfBirth: '2018-03-04' });
    expect(created.status).toBe(201);
    const d3 = created.body.id as string;
    expect((await book(g3, { availabilitySlotId: nextSlot(), patientProfileId: d3 })).status).toBe(201);
    const dependentBefore = await prisma.patientProfile.findUniqueOrThrow({ where: { id: d3 } });

    const deleted = await request(app).delete('/patients/me').set(auth(g3)).send({ password: 'longenough123' });
    expect(deleted.status).toBe(204);

    // Revoked, not deleted: the row is the record of who had access.
    const guardianship = await prisma.guardianship.findFirstOrThrow({ where: { guardianUserId: g3.userId } });
    expect(guardianship.revokedAt).not.toBeNull();
    // The dependent's own profile and history are the dependent's — untouched.
    expect(await prisma.patientProfile.findUniqueOrThrow({ where: { id: d3 } })).toEqual(dependentBefore);
    expect(await prisma.appointment.count({ where: { patientProfileId: d3 } })).toBe(1);

    // The still-valid access token acts for no one.
    // Booking is refused even earlier: deletion clears the verified email.
    const booking = await book(g3, { availabilitySlotId: freeSlots[0], patientProfileId: d3 });
    expect(booking.status).toBe(403);
    expect(booking.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await request(app).get(`/appointments/mine?patientProfileId=${d3}`).set(auth(g3))).status).toBe(404);
    expect((await request(app).get('/patients/me/dependents').set(auth(g3))).status).toBe(404);

    // The purge keeps the guardian's tombstone while the guardianship row exists.
    const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await patients.purgeDeletedPatientAccounts(later);
    expect(await prisma.user.findUnique({ where: { id: g3.userId } })).not.toBeNull();
    expect(await prisma.guardianship.count({ where: { guardianUserId: g3.userId } })).toBe(1);
  });

  describe('migration', () => {
    const newMigration = fs.readdirSync(MIGRATIONS_DIR).find((d) => d.endsWith('_guardian_dependent_profiles'))!;
    const earlier = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((d) => d < newMigration && fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
      .sort();
    const migrationFile = (dir: string) => path.join(MIGRATIONS_DIR, dir, 'migration.sql');

    /** A fresh database at the migration just before this one, seeded —
     * one `prisma db execute` for all of it (each CLI spawn costs seconds). */
    async function databaseAtPreviousMigration(name: string, seedSql: string) {
      await pg.createDatabase(name);
      const script = [...earlier.map((dir) => fs.readFileSync(migrationFile(dir), 'utf8')), seedSql].join('\n;\n');
      dbExecute(urlFor(name), script);
      return urlFor(name);
    }

    async function withClient<T>(url: string, fn: (client: Prisma) => Promise<T>): Promise<T> {
      const { PrismaClient } = await import('@prisma/client');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      // Prisma 7 (ADR 0006): the URL goes to a driver adapter, not `datasources`.
      const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
      try {
        return await fn(client);
      } finally {
        await client.$disconnect();
      }
    }

    const seed = (guardianUserId: string | null) => `
      INSERT INTO "User" ("id","email","passwordHash","role","updatedAt") VALUES ('u1','u1@example.com','x','patient',NOW());
      INSERT INTO "User" ("id","email","passwordHash","role","updatedAt") VALUES ('doc','doc@example.com','x','doctor',NOW());
      INSERT INTO "PatientProfile" ("id","userId","fullName","guardianUserId","updatedAt") VALUES ('p1','u1','Existing Patient',${guardianUserId === null ? 'NULL' : `'${guardianUserId}'`},NOW());
      INSERT INTO "DoctorProfile" ("id","userId","fullName","timeZone","updatedAt") VALUES ('d1','doc','Doc','UTC',NOW());
      INSERT INTO "AvailabilitySlot" ("id","doctorProfileId","status","startTime","endTime","updatedAt") VALUES ('s1','d1','booked',NOW(),NOW() + interval '30 minutes',NOW());
      INSERT INTO "Appointment" ("id","patientProfileId","doctorProfileId","availabilitySlotId","updatedAt") VALUES ('a1','p1','d1','s1',NOW());
    `;

    it('preserves existing profiles and their records', { timeout: 120_000 }, async () => {
      const url = await databaseAtPreviousMigration('migration_clean', seed(null));
      dbExecuteFile(url, migrationFile(newMigration));
      await withClient(url, async (client) => {
        expect(await client.patientProfile.findUniqueOrThrow({ where: { id: 'p1' } })).toMatchObject({ userId: 'u1', fullName: 'Existing Patient' });
        expect(await client.appointment.findUniqueOrThrow({ where: { id: 'a1' } })).toMatchObject({ patientProfileId: 'p1' });
        expect(await client.guardianship.count()).toBe(0);
      });
    });

    it('refuses to run, changing nothing, if legacy guardianUserId data exists', { timeout: 120_000 }, async () => {
      const url = await databaseAtPreviousMigration('migration_legacy', seed('u-someone'));
      expect(() => dbExecuteFile(url, migrationFile(newMigration))).toThrow();
      // The column and its value are still there for an operator to resolve,
      // and nothing else from the migration was applied.
      await withClient(url, async (client) => {
        const legacy = await client.$queryRaw<{ guardianUserId: string }[]>`SELECT "guardianUserId" FROM "PatientProfile" WHERE "id" = 'p1'`;
        expect(legacy).toEqual([{ guardianUserId: 'u-someone' }]);
        const table = await client.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('"Guardianship"') IS NOT NULL AS "exists"`;
        expect(table).toEqual([{ exists: false }]);
      });
    });
  });
});
