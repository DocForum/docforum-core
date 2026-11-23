// Admin referral operations (issue #68): stuck queue with age/reason,
// reassign with doctors-service validation + audit trail, cancel with
// reason (closing any live appointment). Port 5444.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import { encryptField } from '../../src/utils/field-encryption.js';
import {
  acceptReferral,
  consultationRitual,
  createReferral,
  generateSlots,
  installEmailCapture,
  makeAdmin,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5444;
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

describe('admin referral operations', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let gp: Awaited<ReturnType<typeof makeDoctor>>;
  let cardioA: Awaited<ReturnType<typeof makeDoctor>>;
  let cardioB: Awaited<ReturnType<typeof makeDoctor>>;
  let otherSpecialtyDoctor: Awaited<ReturnType<typeof makeDoctor>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;
  let admin: Awaited<ReturnType<typeof makeAdmin>>;
  let cardioSpecialtyId: string;

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
    cardioSpecialtyId = await makeSpecialty(prisma, `Cardiology ${runId}`);
    const dermSpecialtyId = await makeSpecialty(prisma, `Dermatology ${runId}`);
    gp = await makeDoctor(app, prisma, emailedTokens, runId);
    cardioA = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardioSpecialtyId });
    cardioB = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardioSpecialtyId });
    otherSpecialtyDoctor = await makeDoctor(app, prisma, emailedTokens, runId, {
      specialtyId: dermSpecialtyId,
    });
    patient = await makePatient(app, emailedTokens, runId);
    admin = await makeAdmin(app, prisma, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createReferralTo(targetDoctorId: string, snapshotNotes: string) {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const created = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetDoctorId,
      targetSpecialtyId: cardioSpecialtyId,
      snapshotNotes,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  async function pendingReferralToCardioA(options: { backdate?: boolean } = {}) {
    const referralId = await createReferralTo(cardioA.profileId, 'admin fixture notes');
    if (options.backdate) {
      await prisma.referral.update({
        where: { id: referralId },
        data: { createdAt: new Date(Date.now() - 72 * 60 * 60 * 1000) },
      });
    }
    return referralId;
  }

  function adminPost(pathname: string, body: object) {
    return request(app)
      .post(pathname)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send(body);
  }

  function doctorGet(pathname: string, doctor: { accessToken: string }) {
    return request(app).get(pathname).set('Authorization', `Bearer ${doctor.accessToken}`);
  }

  async function waitForAccessLog(referralId: string, accessedBy: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await prisma.accessLog.findMany({
        where: { entityType: 'Referral', entityId: referralId, accessedBy },
      });
      if (rows.length > 0) return rows;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return prisma.accessLog.findMany({
      where: { entityType: 'Referral', entityId: referralId, accessedBy },
    });
  }

  it('serves the stuck queue with age and reason, filtered by status and olderThan', async () => {
    const oldId = await pendingReferralToCardioA({ backdate: true });
    const freshId = await pendingReferralToCardioA();

    const queue = await request(app)
      .get('/referrals/admin/queue?status=pending&olderThan=48h')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(queue.status).toBe(200);
    const ids = (queue.body as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(freshId);
    const oldRow = (queue.body as { id: string; ageMinutes: number; reason: string }[]).find(
      (row) => row.id === oldId,
    );
    expect(oldRow?.ageMinutes).toBeGreaterThanOrEqual(48 * 60 - 5);
    expect(oldRow?.reason).toBe('awaiting patient acceptance');

    const badQuery = await request(app)
      .get('/referrals/admin/queue?olderThan=nonsense')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(badQuery.status).toBe(400);
  });

  it('serves only the target doctor’s incoming referrals, with snapshot notes and an access log', async () => {
    const target = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardioSpecialtyId });
    const other = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardioSpecialtyId });
    const plainId = await createReferralTo(target.profileId, 'plain specialist notes');
    const encryptedId = await createReferralTo(target.profileId, 'before encryption');
    await prisma.referral.update({
      where: { id: encryptedId },
      data: { snapshotNotes: encryptField('encrypted specialist notes')! },
    });

    const inbox = await doctorGet('/referrals/incoming', target);
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const ids = (inbox.body.items as { id: string }[]).map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining([plainId, encryptedId]));
    expect(inbox.body.nextCursor).toBeNull();
    expect(inbox.body.items.find((row: { id: string }) => row.id === plainId).snapshotNotes).toBe(
      'plain specialist notes',
    );
    expect(inbox.body.items.find((row: { id: string }) => row.id === encryptedId).snapshotNotes).toBe(
      'encrypted specialist notes',
    );

    const otherInbox = await doctorGet('/referrals/incoming', other);
    expect(otherInbox.status).toBe(200);
    expect(otherInbox.body.items).toEqual([]);
    const referringInbox = await doctorGet('/referrals/incoming', gp);
    expect(referringInbox.body.items).toEqual([]);
    const asPatient = await request(app)
      .get('/referrals/incoming')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    expect(asPatient.status).toBe(403);
    const asAdmin = await request(app)
      .get('/referrals/incoming')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(asAdmin.status).toBe(403);

    for (const referralId of [plainId, encryptedId]) {
      const logs = await waitForAccessLog(referralId, target.userId);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]).toMatchObject({
        entityType: 'Referral',
        entityId: referralId,
        patientProfileId: patient.profileId,
        accessedBy: target.userId,
        route: 'GET /referrals/incoming',
        detail: 'incoming referral read',
      });
    }
    const otherLogs = await prisma.accessLog.findMany({
      where: { entityType: 'Referral', entityId: plainId, accessedBy: other.userId },
    });
    expect(otherLogs).toEqual([]);
  });

  it('excludes terminal referrals by default, includes them by filter, and keyset-paginates', async () => {
    const target = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardioSpecialtyId });
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const referralId = await createReferralTo(target.profileId, `paging ${index}`);
      await prisma.referral.update({
        where: { id: referralId },
        data: { createdAt: new Date(Date.now() - (4 - index) * 60 * 60 * 1000) },
      });
      ids.push(referralId);
    }
    const cancelled = await adminPost(`/referrals/admin/${ids[1]}/cancel`, { reason: 'duplicate' });
    expect(cancelled.status).toBe(200);
    await prisma.referral.update({
      where: { id: ids[3] },
      data: { status: 'expired', expiredAt: new Date(), expiredReason: 'ttl' },
    });

    const defaults = await doctorGet('/referrals/incoming', target);
    expect(defaults.status).toBe(200);
    expect(defaults.body.items.map((row: { id: string }) => row.id)).toEqual([ids[2], ids[0]]);
    expect(defaults.body.nextCursor).toBeNull();

    const cancelledPage = await doctorGet('/referrals/incoming?status=cancelled', target);
    expect(cancelledPage.body.items.map((row: { id: string }) => row.id)).toEqual([ids[1]]);
    const expiredPage = await doctorGet('/referrals/incoming?status=expired', target);
    expect(expiredPage.body.items.map((row: { id: string }) => row.id)).toEqual([ids[3]]);

    const first = await doctorGet('/referrals/incoming?limit=1', target);
    expect(first.body.items.map((row: { id: string }) => row.id)).toEqual([ids[2]]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await doctorGet(
      `/referrals/incoming?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      target,
    );
    expect(second.body.items.map((row: { id: string }) => row.id)).toEqual([ids[0]]);
    expect(second.body.nextCursor).toBeNull();

    expect((await doctorGet('/referrals/incoming?cursor=not-a-cursor', target)).status).toBe(400);
    expect((await doctorGet('/referrals/incoming?status=unknown', target)).status).toBe(400);
  });

  it('reassigns a stuck referral to a verified doctor in the specialty, audited, snapshot untouched', async () => {
    const referralId = await pendingReferralToCardioA();
    const beforeOld = await doctorGet('/referrals/incoming', cardioA);
    expect(beforeOld.body.items.some((row: { id: string }) => row.id === referralId)).toBe(true);
    const beforeNew = await doctorGet('/referrals/incoming', cardioB);
    expect(beforeNew.body.items.some((row: { id: string }) => row.id === referralId)).toBe(false);

    const res = await adminPost(`/referrals/admin/${referralId}/reassign`, {
      targetDoctorId: cardioB.profileId,
      reason: 'cardioA on leave',
    });
    expect(res.status).toBe(200);
    expect(res.body.targetDoctorId).toBe(cardioB.profileId);
    expect(res.body.snapshotNotes).toBe('admin fixture notes');
    expect(res.body.status).toBe('pending');

    // Referral admin actions are rows in the one append-only AuditEvent
    // table (issue #43), written through the audit module's service as
    // `entityType: 'Referral'` — there is no second referral audit table.
    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'Referral', entityId: referralId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('referral.reassign');
    expect(events[0].actorUserId).toBe(admin.userId);
    expect(events[0].metadata).toMatchObject({
      fromDoctorId: cardioA.profileId,
      toDoctorId: cardioB.profileId,
      reason: 'cardioA on leave',
    });

    const afterOld = await doctorGet('/referrals/incoming', cardioA);
    expect(afterOld.body.items.some((row: { id: string }) => row.id === referralId)).toBe(false);
    const afterNew = await doctorGet('/referrals/incoming', cardioB);
    const moved = afterNew.body.items.find((row: { id: string }) => row.id === referralId);
    expect(moved).toBeDefined();
    expect(moved.snapshotNotes).toBe('admin fixture notes');
  });

  it('validates reassignment targets through the doctors service', async () => {
    // unverified target
    const unverified = await makeDoctor(app, prisma, emailedTokens, runId + 1, {
      specialtyId: cardioSpecialtyId,
    });
    await prisma.doctorProfile.update({
      where: { id: unverified.profileId },
      data: { verificationStatus: 'pending' },
    });
    const unverifiedRes = await adminPost(`/referrals/admin/${await pendingReferralToCardioA()}/reassign`, {
      targetDoctorId: unverified.profileId,
      reason: 'attempt',
    });
    expect(unverifiedRes.status).toBe(422);

    // verified but wrong specialty
    const wrongSpecialtyRes = await adminPost(
      `/referrals/admin/${await pendingReferralToCardioA()}/reassign`,
      { targetDoctorId: otherSpecialtyDoctor.profileId, reason: 'attempt' },
    );
    expect(wrongSpecialtyRes.status).toBe(422);

    // already-targeted doctor
    const referralId = await pendingReferralToCardioA();
    const sameDoctorRes = await adminPost(`/referrals/admin/${referralId}/reassign`, {
      targetDoctorId: cardioA.profileId,
      reason: 'attempt',
    });
    expect(sameDoctorRes.status).toBe(409);

    // reassigning to the referring GP
    const toGpRes = await adminPost(`/referrals/admin/${await pendingReferralToCardioA()}/reassign`, {
      targetDoctorId: gp.profileId,
      reason: 'attempt',
    });
    expect(toGpRes.status).toBe(422);

    // unknown referral
    const missingRes = await adminPost('/referrals/admin/00000000-0000-0000-0000-000000000000/reassign', {
      targetDoctorId: cardioB.profileId,
      reason: 'attempt',
    });
    expect(missingRes.status).toBe(404);
  });

  it('refuses to reassign a non-pending referral', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const created = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetDoctorId: cardioA.profileId,
      targetSpecialtyId: cardioSpecialtyId,
      snapshotNotes: 'accepted one',
    });
    const slots = await generateSlots(app, cardioA, 2);
    const accepted = await acceptReferral(app, patient, created.body.id, slots[0]);
    expect(accepted.status).toBe(200);

    const res = await adminPost(`/referrals/admin/${created.body.id}/reassign`, {
      targetDoctorId: cardioB.profileId,
      reason: 'attempt on accepted',
    });
    expect(res.status).toBe(409);
  });

  it('cancels a pending referral with a reason, audited', async () => {
    const referralId = await pendingReferralToCardioA();
    const res = await adminPost(`/referrals/admin/${referralId}/cancel`, { reason: 'patient moved abroad' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledReason).toBe('patient moved abroad');

    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'Referral', entityId: referralId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.action)).toContain('referral.cancel');
  });

  it('cancelling an accepted referral also cancels its live appointment and frees the slot', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const created = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetDoctorId: cardioA.profileId,
      targetSpecialtyId: cardioSpecialtyId,
      snapshotNotes: 'accepted, will be admin-cancelled',
    });
    const slots = await generateSlots(app, cardioA, 2);
    const accepted = await acceptReferral(app, patient, created.body.id, slots[0]);
    expect(accepted.status).toBe(200);
    const appointmentId = accepted.body.resultingAppointmentId as string;
    const slotId = slots[0];

    const res = await adminPost(`/referrals/admin/${created.body.id}/cancel`, { reason: 'duplicate care path' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(appointment.status).toBe('cancelled');
    expect(appointment.availabilitySlotId).toBeNull();
    const slot = await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } });
    expect(slot.status).toBe('open');
  });

  it('refuses to cancel a terminal referral and serves the audit trail', async () => {
    const referralId = await pendingReferralToCardioA();
    const cancelled = await adminPost(`/referrals/admin/${referralId}/cancel`, { reason: 'first' });
    expect(cancelled.status).toBe(200);
    const again = await adminPost(`/referrals/admin/${referralId}/cancel`, { reason: 'second' });
    expect(again.status).toBe(409);

    const trail = await request(app)
      .get(`/referrals/admin/${referralId}/audit-events`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(trail.status).toBe(200);
    expect(trail.body).toHaveLength(1);
    expect(trail.body[0].action).toBe('referral.cancel');
    expect(trail.body[0].entityType).toBe('Referral');
    expect(trail.body[0].metadata).toMatchObject({ reason: 'first' });
  });

  it('rejects admin operations without the admin role', async () => {
    const referralId = await pendingReferralToCardioA();
    const asDoctor = await request(app)
      .post(`/referrals/admin/${referralId}/cancel`)
      .set('Authorization', `Bearer ${gp.accessToken}`)
      .send({ reason: 'nope' });
    expect(asDoctor.status).toBe(403);
  });
});
