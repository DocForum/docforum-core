// Integration tests for account deletion with clinical-record retention
// (Phase 8, issue #41, docs/adr/0010), against a populated database:
// password re-confirmation, PII anonymised, login/refresh deactivated, the
// original address reusable, appointments + payments surviving byte-for-byte,
// the RESTRICT foreign keys, idempotency (repeat and concurrent), and the
// tombstone purge touching eligible rows only. Self-contained, same
// embedded-Postgres pattern as booking.test.mts. Own port (5453).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5453;
const runId = Date.now();
const PASSWORD = 'longenough123';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-deletion-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;
type PatientsService = typeof import('../../src/modules/patients/services/index.js');

interface Patient {
  email: string;
  userId: string;
  profileId: string;
  token: string;
  csrfToken: string;
  refreshCookie: string;
}

const emailedTokens = new Map<string, string>();

describe('account deletion with clinical-record retention', () => {
  let app: App;
  let prisma: Prisma;
  let patients: PatientsService;
  let doctorToken: string;
  let doctorProfileId: string;
  let facilityId: string;
  let alice: Patient; // has an appointment + payments
  let bob: Patient; // unrelated, must be untouched
  let carol: Patient; // no records, unverified
  let dave: Patient; // no records, deleted recently
  let erin: Patient; // used for the throttle test

  async function signup(role: 'patient' | 'doctor', label: string, verify = true) {
    const email = `${label}-${runId}@example.com`;
    const res = await request(app).post('/auth/signup').send({ role, email, password: PASSWORD, fullName: `${label} Fullname` });
    expect(res.status).toBe(200);
    if (verify) {
      const verified = await request(app).post('/auth/verify-email').send({ token: emailedTokens.get(email) });
      expect(verified.status).toBe(200);
    }
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('docforum_refresh='))!;
    return {
      email,
      userId: res.body.user.id as string,
      token: res.body.accessToken as string,
      csrfToken: res.body.csrfToken as string,
      refreshCookie: cookie.split(';')[0]!,
    };
  }

  async function signupPatient(label: string, verify = true): Promise<Patient> {
    const user = await signup('patient', label, verify);
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: user.userId } });
    return { ...user, profileId: profile.id };
  }

  function deleteAccount(patient: Patient, body: object | undefined) {
    const req = request(app).delete('/patients/me').set('Authorization', `Bearer ${patient.token}`);
    return body === undefined ? req : req.send(body);
  }

  async function snapshotRecords(profileId: string) {
    return {
      appointments: await prisma.appointment.findMany({ where: { patientProfileId: profileId }, orderBy: { id: 'asc' } }),
      payments: await prisma.paymentIntent.findMany({ where: { patientProfileId: profileId }, orderBy: { id: 'asc' } }),
    };
  }

  async function snapshotAccount(p: Patient) {
    return {
      user: await prisma.user.findUnique({ where: { id: p.userId } }),
      profile: await prisma.patientProfile.findUnique({ where: { id: p.profileId } }),
      ...(await snapshotRecords(p.profileId)),
    };
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
    process.env.ACCOUNT_PURGE_GRACE_HOURS = '24';

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const authServices = await import('../../src/modules/auth/services/index.js');
    patients = await import('../../src/modules/patients/services/index.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    authServices.setEmailSender(async (message) => {
      const match = /[?&]token=([^&\s]+)/.exec(message.text);
      if (match) emailedTokens.set(message.to, decodeURIComponent(match[1]));
    });

    const doctor = await signup('doctor', 'deletion-doctor');
    doctorToken = doctor.token;
    doctorProfileId = (await prisma.doctorProfile.findUniqueOrThrow({ where: { userId: doctor.userId } })).id;

    alice = await signupPatient('alice');
    bob = await signupPatient('bob');
    carol = await signupPatient('carol', false);
    dave = await signupPatient('dave');
    erin = await signupPatient('erin');

    // Populate the fields that must be anonymised, beyond what signup sets.
    for (const p of [alice, bob]) {
      await prisma.user.update({ where: { id: p.userId }, data: { phone: '+2348000000000' } });
      await prisma.patientProfile.update({
        where: { id: p.profileId },
        data: { dateOfBirth: new Date('1990-05-01') },
      });
    }

    // Real bookings through the API for Alice and Bob.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request(app)
      .post(`/availability/doctors/${doctorProfileId}/slots/generate`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({ date: tomorrow, startHour: 9, endHour: 11, slotLengthMinutes: 30 });
    const slots = (await request(app).get(`/availability/doctors/${doctorProfileId}/slots`)).body as { id: string }[];
    for (const [i, p] of [alice, bob].entries()) {
      const booked = await request(app)
        .post('/appointments')
        .set('Authorization', `Bearer ${p.token}`)
        .send({ availabilitySlotId: slots[i]!.id });
      expect(booked.status).toBe(201);
    }

    const facilityUser = await prisma.user.create({ data: { email: `lab-${runId}@example.com`, passwordHash: 'x', role: 'facility' } });
    facilityId = (await prisma.facilityProfile.create({ data: { userId: facilityUser.id, name: 'Lab', type: 'lab' } })).id;
    for (const p of [alice, bob]) {
      // Main replaced PaymentIntent's polymorphic `orderType`/`orderId` with
      // real `Prescription`/`LabOrder` FKs under a "exactly one order" CHECK
      // (issue #85), so build the chain consultation -> lab order -> intent
      // on the appointment this test already booked (no extra appointments:
      // the counts below are part of what is asserted).
      const appointment = await prisma.appointment.findFirstOrThrow({ where: { patientProfileId: p.profileId } });
      const consultation = await prisma.consultation.create({ data: { appointmentId: appointment.id } });
      const labOrder = await prisma.labOrder.create({
        data: {
          consultationId: consultation.id,
          patientProfileId: p.profileId,
          orderingDoctorId: doctorProfileId,
          facilityProfileId: facilityId,
          amountStroops: 1000n,
          testType: 'Test panel',
        },
      });
      await prisma.paymentIntent.create({
        data: {
          labOrderId: labOrder.id,
          patientProfileId: p.profileId,
          facilityId,
          amount: 1000n,
          assetCode: 'XLM',
          status: 'escrowed',
          escrowId: 7n,
          stellarTxHash: 'f'.repeat(64),
        },
      });
    }

    // One failed login for Alice, so a throttle bucket keyed by her address exists.
    const failed = await request(app).post('/auth/login').send({ email: alice.email, password: 'wrong-password' });
    expect(failed.status).toBe(401);
  }, 180_000);

  afterAll(async () => {
    const authServices = await import('../../src/modules/auth/services/index.js');
    authServices.resetEmailSender();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects a missing or wrong password and non-patients, changing nothing', async () => {
    const before = await snapshotAccount(alice);
    expect((await deleteAccount(alice, undefined)).status).toBe(400);
    expect((await deleteAccount(alice, { password: '' })).status).toBe(400);
    const wrong = await deleteAccount(alice, { password: 'not-my-password' });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ message: 'Password confirmation failed.', code: 'PASSWORD_CONFIRMATION_FAILED' });

    const asDoctor = await request(app).delete('/patients/me').set('Authorization', `Bearer ${doctorToken}`).send({ password: PASSWORD });
    expect(asDoctor.status).toBe(403);
    expect((await request(app).delete('/patients/me').send({ password: PASSWORD })).status).toBe(401);

    const after = await snapshotAccount(alice);
    expect({ ...after, user: { ...after.user, updatedAt: null } }).toEqual({ ...before, user: { ...before.user, updatedAt: null } });
  });

  it('counts wrong confirmations against the login throttle', async () => {
    // Every request in this file comes from the same loopback IP, so the
    // per-IP bucket is shared; isolate this test to the per-account bucket.
    const clearIpBuckets = async () => {
      await prisma.loginAttempt.deleteMany({ where: { scope: 'ip' } });
    };
    await clearIpBuckets();
    onTestFinished(clearIpBuckets);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await deleteAccount(erin, { password: 'guess' })).status);
    expect(statuses.slice(0, 2)).toEqual([403, 403]);
    const throttled = await deleteAccount(erin, { password: PASSWORD });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers['retry-after'])).toBeGreaterThan(0);
    // Still not deleted.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: erin.userId } })).deletedAt).toBeNull();
  });

  it('anonymises identity and keeps appointments and payments byte-for-byte', async () => {
    const recordsBefore = await snapshotRecords(alice.profileId);
    expect(recordsBefore.appointments).toHaveLength(1);
    expect(recordsBefore.payments).toHaveLength(1);
    const oldHash = (await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } })).passwordHash;
    expect(await prisma.emailVerificationToken.count({ where: { userId: alice.userId } })).toBeGreaterThan(0);
    expect(await prisma.loginAttempt.count({ where: { scope: 'email', key: alice.email.toLowerCase() } })).toBe(1);

    const res = await deleteAccount(alice, { password: PASSWORD });
    expect(res.status).toBe(204);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: alice.userId } });
    expect(user.email).toBe(`deleted+${alice.userId}@deleted.invalid`);
    expect(user.phone).toBeNull();
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.deletedAt).toBeInstanceOf(Date);
    expect(user.passwordHash).not.toBe(oldHash);
    expect(await bcrypt.compare(PASSWORD, user.passwordHash)).toBe(false);

    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { id: alice.profileId } });
    expect(profile).toMatchObject({ fullName: 'Deleted patient', dateOfBirth: null });
    expect(profile.anonymizedAt?.getTime()).toBe(user.deletedAt!.getTime());

    // No personal field survives anywhere on the two rows.
    const rows = JSON.stringify({ user, profile });
    for (const pii of [alice.email, 'alice Fullname', '+2348000000000', '1990-05-01']) expect(rows).not.toContain(pii);

    expect(await prisma.emailVerificationToken.count({ where: { userId: alice.userId } })).toBe(0);
    expect(await prisma.loginAttempt.count({ where: { scope: 'email', key: alice.email.toLowerCase() } })).toBe(0);

    // Clinical and payment records: identical, still linked to the profile.
    expect(await snapshotRecords(alice.profileId)).toEqual(recordsBefore);
    // The slot link is nullable since main made cancellations release it
    // (Phase 3); this appointment was never cancelled, so it still points at one.
    const slotId = recordsBefore.appointments[0]!.availabilitySlotId;
    expect(slotId).not.toBeNull();
    const slot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId! } });
    expect(slot.status).toBe('booked');
  });

  it('deactivates login, refresh and every patient route for the old session', async () => {
    const login = await request(app).post('/auth/login').send({ email: alice.email, password: PASSWORD });
    expect(login.status).toBe(401);
    const tombstoneLogin = await request(app)
      .post('/auth/login')
      .send({ email: `deleted+${alice.userId}@deleted.invalid`, password: PASSWORD });
    expect(tombstoneLogin.status).toBe(401);

    const refresh = await request(app)
      .post('/auth/refresh')
      .set('Cookie', alice.refreshCookie)
      .set('X-CSRF-Token', alice.csrfToken);
    expect(refresh.status).toBe(401);

    // The access token is a stateless JWT still inside its TTL (no revocation
    // list yet, issue #18) — but nothing reachable with it.
    const mine = await request(app).get('/appointments/mine').set('Authorization', `Bearer ${alice.token}`);
    expect(mine.status).toBe(404);
    const slots = (await request(app).get(`/availability/doctors/${doctorProfileId}/slots`)).body as { id: string }[];
    const book = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ availabilitySlotId: slots[0]!.id });
    expect(book.status).toBe(403);
    expect(book.body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('frees the original address for a brand-new, empty signup', async () => {
    const res = await request(app).post('/auth/signup').send({ role: 'patient', email: alice.email, password: 'another-password', fullName: 'New Alice' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).not.toBe(alice.userId);
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { userId: res.body.user.id } });
    expect(profile.id).not.toBe(alice.profileId);
    expect(await prisma.appointment.count({ where: { patientProfileId: profile.id } })).toBe(0);
    // The new account can log in; the old one still can't be reached.
    expect((await request(app).post('/auth/login').send({ email: alice.email, password: 'another-password' })).status).toBe(200);
  });

  it('is idempotent: a repeat deletion is a no-op, concurrent ones anonymise once', async () => {
    const before = await snapshotAccount(alice);
    for (const password of [PASSWORD, 'anything']) {
      expect((await deleteAccount(alice, { password })).status).toBe(204);
    }
    expect(await snapshotAccount(alice)).toEqual(before);

    const [first, second] = await Promise.all([deleteAccount(dave, { password: PASSWORD }), deleteAccount(dave, { password: PASSWORD })]);
    expect([first.status, second.status]).toEqual([204, 204]);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: dave.userId } });
    expect(user.deletedAt).not.toBeNull();
    expect(user.email).toBe(`deleted+${dave.userId}@deleted.invalid`);
  });

  it('lets an unverified account delete itself', async () => {
    expect((await deleteAccount(carol, { password: PASSWORD })).status).toBe(204);
    expect((await prisma.patientProfile.findUniqueOrThrow({ where: { id: carol.profileId } })).anonymizedAt).not.toBeNull();
  });

  it('enforces RESTRICT: a deleted patient with records cannot be hard-deleted by accident', async () => {
    // Each refusal is checked with the same classifier the purge uses as its
    // race backstop, against the error Postgres actually raises.
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => 'deleted',
        (err) => (patients.isForeignKeyRefusal(err) ? 'refused' : `other: ${String(err)}`),
      );
    expect(await refusal(prisma.user.delete({ where: { id: alice.userId } }))).toBe('refused');
    expect(await refusal(prisma.patientProfile.delete({ where: { id: alice.profileId } }))).toBe('refused');
    // Even a patient with no records: the User row can't go while its profile exists.
    expect(await refusal(prisma.user.delete({ where: { id: carol.userId } }))).toBe('refused');
    // And the purge's own delete path is refused for a profile with records.
    expect(
      await refusal(prisma.$transaction((tx) => tx.patientProfile.deleteMany({ where: { id: alice.profileId } }))),
    ).toBe('refused');
    expect(await prisma.user.count({ where: { id: { in: [alice.userId, carol.userId] } } })).toBe(2);
  });

  it('purges only record-free tombstones past the grace period, and is safe to re-run', async () => {
    const bobBefore = await snapshotAccount(bob);
    const aliceRecords = await snapshotRecords(alice.profileId);
    // Carol deleted long ago; Dave just now (inside the grace period).
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await prisma.patientProfile.update({ where: { id: carol.profileId }, data: { anonymizedAt: longAgo } });
    await prisma.patientProfile.update({ where: { id: alice.profileId }, data: { anonymizedAt: longAgo } });

    const result = await patients.purgeDeletedPatientAccounts();
    expect(result).toEqual({ purged: 1, held: 1, failed: 0 });

    expect(await prisma.user.findUnique({ where: { id: carol.userId } })).toBeNull();
    expect(await prisma.patientProfile.findUnique({ where: { id: carol.profileId } })).toBeNull();
    // Dave: still inside the grace period.
    expect(await prisma.patientProfile.findUnique({ where: { id: dave.profileId } })).not.toBeNull();
    // Alice: has records, kept with them.
    expect(await prisma.patientProfile.findUnique({ where: { id: alice.profileId } })).not.toBeNull();
    expect(await snapshotRecords(alice.profileId)).toEqual(aliceRecords);
    // Bob and live accounts: untouched.
    expect(await snapshotAccount(bob)).toEqual(bobBefore);
    expect(await prisma.user.count({ where: { deletedAt: null, role: 'patient' } })).toBeGreaterThanOrEqual(3);

    // Re-running purges nothing new; moving the clock past Dave's grace purges him.
    expect(await patients.purgeDeletedPatientAccounts()).toEqual({ purged: 0, held: 1, failed: 0 });
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await patients.purgeDeletedPatientAccounts(later)).toEqual({ purged: 1, held: 1, failed: 0 });
    expect(await prisma.user.findUnique({ where: { id: dave.userId } })).toBeNull();
  });

  it('deletes exports at anonymisation, and holds a tombstone for referrals and access logs too', async () => {
    expect(patients.listRetentionHolds().map((hold) => hold.name)).toEqual(
      expect.arrayContaining(['appointments', 'payments', 'orders', 'referrals', 'access_logs']),
    );
    // Alice's lab order alone is enough for the orders hold.
    const ordersHold = patients.listRetentionHolds().find((hold) => hold.name === 'orders')!;
    expect(await ordersHold.holds(alice.profileId)).toBe(true);

    // A fresh patient: erin's address is locked by the throttle test.
    const frank = await signupPatient('frank');
    // An export (a derived copy, ADR 0010) goes with the anonymisation.
    const exportRow = await prisma.patientExport.create({
      data: { patientProfileId: frank.profileId, chunks: { create: { attempt: 0, seq: 0, data: '{}' } } },
    });
    expect((await deleteAccount(frank, { password: PASSWORD })).status).toBe(204);
    expect(await prisma.patientExport.count({ where: { patientProfileId: frank.profileId } })).toBe(0);
    expect(await prisma.patientExportChunk.count({ where: { exportId: exportRow.id } })).toBe(0);

    // A referral (RESTRICT) and an access-log row (CASCADE) each keep the
    // tombstone; the access log must not be erased by the purge.
    const consultation = await prisma.consultation.findFirstOrThrow();
    const referral = await prisma.referral.create({
      data: {
        patientProfileId: frank.profileId,
        sourceConsultationId: consultation.id,
        referringDoctorId: doctorProfileId,
        targetDoctorId: doctorProfileId,
        snapshotNotes: 'snapshot',
      },
    });
    const accessLog = await prisma.accessLog.create({
      data: { patientProfileId: frank.profileId, entityType: 'PatientProfile', entityId: frank.profileId },
    });
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);

    expect((await patients.purgeDeletedPatientAccounts(later)).purged).toBe(0);
    expect(await prisma.patientProfile.findUnique({ where: { id: frank.profileId } })).not.toBeNull();

    await prisma.referral.delete({ where: { id: referral.id } });
    expect((await patients.purgeDeletedPatientAccounts(later)).purged).toBe(0);
    expect(await prisma.accessLog.findUnique({ where: { id: accessLog.id } })).not.toBeNull();

    // Once the access log's own retention prune has removed it, the tombstone goes.
    await prisma.accessLog.delete({ where: { id: accessLog.id } });
    expect((await patients.purgeDeletedPatientAccounts(later)).purged).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: frank.userId } })).toBeNull();
  });

  it('leaves unrelated patients completely unchanged', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: bob.userId } });
    expect(user).toMatchObject({ email: bob.email, phone: '+2348000000000', deletedAt: null });
    expect(user.emailVerifiedAt).not.toBeNull();
    const profile = await prisma.patientProfile.findUniqueOrThrow({ where: { id: bob.profileId } });
    expect(profile).toMatchObject({ fullName: 'bob Fullname', anonymizedAt: null });
    expect((await request(app).post('/auth/login').send({ email: bob.email, password: PASSWORD })).status).toBe(200);
    expect((await request(app).get('/appointments/mine').set('Authorization', `Bearer ${bob.token}`)).body).toHaveLength(1);
  });
});
