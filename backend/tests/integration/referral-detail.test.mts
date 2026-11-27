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
  createConsultation,
  createReferral,
  generateSlots,
  installEmailCapture,
  makeAdmin,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
  setAppointmentStatus,
  shiftSlotToPast,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5483;
const runId = Date.now();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-referral-detail-pg-'));
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
type Role = 'patient' | 'doctor' | 'facility' | 'admin';
type SignAccessToken = (payload: { sub: string; role: Role }) => string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function yearsAgo(years: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
}

describe('referral detail endpoint', () => {
  let app: App;
  let prisma: Prisma;
  let signAccessToken: SignAccessToken;
  const emailedTokens = new Map<string, string>();
  let gp: Awaited<ReturnType<typeof makeDoctor>>;
  let target: Awaited<ReturnType<typeof makeDoctor>>;
  let replacement: Awaited<ReturnType<typeof makeDoctor>>;
  let otherDoctor: Awaited<ReturnType<typeof makeDoctor>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;
  let otherPatient: Awaited<ReturnType<typeof makePatient>>;
  let admin: Awaited<ReturnType<typeof makeAdmin>>;
  let facilityToken: string;
  let specialtyId: string;

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

    app = (await import('../../src/app.js')).createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    signAccessToken = (await import('../../src/modules/auth/services/tokens.js')).signAccessToken;
    await installEmailCapture(emailedTokens);

    specialtyId = await makeSpecialty(prisma, `Detail Cardiology ${runId}`);
    gp = await makeDoctor(app, prisma, emailedTokens, runId);
    target = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    replacement = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    otherDoctor = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId });
    patient = await makePatient(app, emailedTokens, runId);
    otherPatient = await makePatient(app, emailedTokens, runId);
    admin = await makeAdmin(app, prisma, emailedTokens, runId);

    const facility = await prisma.user.create({
      data: {
        email: `referral-detail-facility-${runId}@example.com`,
        passwordHash: 'unused',
        role: 'facility',
        emailVerifiedAt: new Date(),
      },
    });
    facilityToken = signAccessToken({ sub: facility.id, role: 'facility' });
  }, 180_000);

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function getDetail(token: string | null, referralId: string, patientProfileId?: string) {
    const query = patientProfileId ? `?patientProfileId=${encodeURIComponent(patientProfileId)}` : '';
    const call = request(app).get(`/referrals/${referralId}${query}`);
    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  }

  function adminPost(pathname: string, body: object) {
    return request(app)
      .post(pathname)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send(body);
  }

  async function pendingReferral(notes = 'detail fixture notes') {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const created = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetDoctorId: target.profileId,
      targetSpecialtyId: specialtyId,
      snapshotNotes: notes,
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  async function dependentReferral(guardianToken: string, dependentProfileId: string) {
    const slots = await generateSlots(app, gp, 2);
    const slotId = slots[0];
    const booked = await request(app)
      .post('/appointments')
      .set('Authorization', `Bearer ${guardianToken}`)
      .send({ availabilitySlotId: slotId, patientProfileId: dependentProfileId });
    expect(booked.status).toBe(201);
    await shiftSlotToPast(prisma, slotId);
    const completed = await setAppointmentStatus(app, gp, booked.body.id, 'completed');
    expect(completed.status).toBe(200);
    const consultation = await createConsultation(app, gp, booked.body.id);
    const created = await createReferral(app, gp, {
      sourceConsultationId: consultation.id,
      targetDoctorId: target.profileId,
      targetSpecialtyId: specialtyId,
      snapshotNotes: 'dependent referral',
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  it('returns the full row to the patient and 404 to other patients and facilities', async () => {
    const referralId = await pendingReferral();
    const res = await getDetail(patient.accessToken, referralId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: referralId,
      status: 'pending',
      patientProfileId: patient.profileId,
      referringDoctorId: gp.profileId,
      targetDoctorId: target.profileId,
      targetSpecialtyId: specialtyId,
      snapshotNotes: 'detail fixture notes',
      expiredAt: null,
      expiredReason: null,
      cancelledReason: null,
      resultingAppointmentId: null,
    });
    expect(res.body.createdAt).toBeTruthy();
    expect(res.body.updatedAt).toBeTruthy();

    expect((await getDetail(otherPatient.accessToken, referralId)).status).toBe(404);
    expect((await getDetail(facilityToken, referralId)).status).toBe(404);
    expect((await getDetail(null, referralId)).status).toBe(401);
  });

  it('allows the referring doctor and current target doctor, 404s other and replaced doctors', async () => {
    const referralId = await pendingReferral();
    expect((await getDetail(gp.accessToken, referralId)).status).toBe(200);
    expect((await getDetail(target.accessToken, referralId)).status).toBe(200);
    expect((await getDetail(otherDoctor.accessToken, referralId)).status).toBe(404);

    const reassigned = await adminPost(`/referrals/admin/${referralId}/reassign`, {
      targetDoctorId: replacement.profileId,
      reason: 'target on leave',
    });
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.targetDoctorId).toBe(replacement.profileId);
    expect((await getDetail(replacement.accessToken, referralId)).status).toBe(200);
    expect((await getDetail(target.accessToken, referralId)).status).toBe(404);
    expect((await getDetail(gp.accessToken, referralId)).status).toBe(200);
  });

  it('allows admins and keeps named routes ahead of the detail route', async () => {
    const referralId = await pendingReferral();
    expect((await getDetail(admin.accessToken, referralId)).status).toBe(200);
    expect((await getDetail(patient.accessToken, '00000000-0000-0000-0000-000000000000')).status).toBe(404);

    const mine = await request(app)
      .get('/referrals/mine')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.referrals).toEqual(expect.any(Array));

    const incoming = await request(app)
      .get('/referrals/incoming')
      .set('Authorization', `Bearer ${target.accessToken}`);
    expect(incoming.status).toBe(200);
    expect(incoming.body.items).toEqual(expect.any(Array));

    const created = await request(app)
      .get('/referrals/created')
      .set('Authorization', `Bearer ${gp.accessToken}`);
    expect(created.status).toBe(200);

    const queue = await request(app)
      .get('/referrals/admin/queue')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(queue.status).toBe(200);
    expect(queue.body).toEqual(expect.any(Array));
  });

  it('records successful reads against the referral and its record owner', async () => {
    const referralId = await pendingReferral();
    expect((await getDetail(patient.accessToken, referralId)).status).toBe(200);
    expect((await getDetail(admin.accessToken, referralId)).status).toBe(200);

    let rows = await prisma.accessLog.findMany({
      where: { entityType: 'Referral', entityId: referralId },
    });
    for (let attempt = 0; rows.length < 2 && attempt < 20; attempt += 1) {
      await sleep(50);
      rows = await prisma.accessLog.findMany({
        where: { entityType: 'Referral', entityId: referralId },
      });
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accessedBy: patient.userId,
          patientProfileId: patient.profileId,
          route: 'GET /referrals/:referralId',
          detail: 'referral detail read',
        }),
        expect.objectContaining({
          accessedBy: admin.userId,
          patientProfileId: patient.profileId,
          route: 'GET /referrals/:referralId',
        }),
      ]),
    );
  });

  it('includes appointment and terminal-state fields already on the row', async () => {
    const acceptedId = await pendingReferral();
    const slots = await generateSlots(app, target, 2);
    const accepted = await acceptReferral(app, patient, acceptedId, slots[0]);
    expect(accepted.status).toBe(200);
    const appointmentId = accepted.body.resultingAppointmentId as string;
    expect(appointmentId).toBeTruthy();

    const afterAccept = await getDetail(patient.accessToken, acceptedId);
    expect(afterAccept.body).toMatchObject({
      status: 'accepted',
      resultingAppointmentId: appointmentId,
    });

    const cancelled = await adminPost(`/referrals/admin/${acceptedId}/cancel`, {
      reason: 'duplicate care path',
    });
    expect(cancelled.status).toBe(200);
    const afterCancel = await getDetail(patient.accessToken, acceptedId);
    expect(afterCancel.body).toMatchObject({
      status: 'cancelled',
      cancelledReason: 'duplicate care path',
      resultingAppointmentId: appointmentId,
    });

    const expiredId = await pendingReferral();
    const expiredAt = new Date(Date.now() - 60_000);
    await prisma.referral.update({
      where: { id: expiredId },
      data: { status: 'expired', expiredAt, expiredReason: 'ttl' },
    });
    const afterExpiry = await getDetail(patient.accessToken, expiredId);
    expect(afterExpiry.body).toMatchObject({
      status: 'expired',
      expiredAt: expiredAt.toISOString(),
      expiredReason: 'ttl',
    });
  });

  it('returns readable snapshot notes for encrypted legacy rows', async () => {
    const referralId = await pendingReferral();
    const { encryptField } = await import('../../src/utils/field-encryption.js');
    const encrypted = encryptField('detail snapshot after encryption');
    expect(encrypted).toBeTruthy();
    await prisma.referral.update({
      where: { id: referralId },
      data: { snapshotNotes: encrypted as string },
    });

    const res = await getDetail(patient.accessToken, referralId);
    expect(res.status).toBe(200);
    expect(res.body.snapshotNotes).toBe('detail snapshot after encryption');
  });

  it('lets an active guardian read a dependent referral by naming the dependent', async () => {
    const guardian = await makePatient(app, emailedTokens, runId);
    const otherGuardian = await makePatient(app, emailedTokens, runId);
    const dependent = await request(app)
      .post('/patients/me/dependents')
      .set('Authorization', `Bearer ${guardian.accessToken}`)
      .send({ fullName: 'Referral Detail Child', dateOfBirth: yearsAgo(8) });
    expect(dependent.status).toBe(201);
    const dependentProfileId = dependent.body.id as string;

    const referralId = await dependentReferral(guardian.accessToken, dependentProfileId);
    expect((await getDetail(guardian.accessToken, referralId)).status).toBe(404);
    const active = await getDetail(guardian.accessToken, referralId, dependentProfileId);
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({
      id: referralId,
      patientProfileId: dependentProfileId,
      referringDoctorId: gp.profileId,
      targetDoctorId: target.profileId,
    });
    expect((await getDetail(otherGuardian.accessToken, referralId, dependentProfileId)).status).toBe(404);

    await prisma.guardianship.updateMany({
      where: { guardianUserId: guardian.userId, dependentProfileId },
      data: { revokedAt: new Date() },
    });
    const revoked = await getDetail(guardian.accessToken, referralId, dependentProfileId);
    expect(revoked.status).toBe(403);
    expect(revoked.body.code).toBe('GUARDIANSHIP_INACTIVE');
  });
});
