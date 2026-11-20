import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5499;
const runId = Date.now();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-specver-pg-'));
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'docforum', password: 'docforum', port: PORT, persistent: false });
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;
const emailedTokens = new Map<string, string>();

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

describe('per-specialty credential verification', () => {
  let app: App;
  let prisma: Prisma;
  let adminToken: string;
  let adminUserId: string;
  let doctorToken: string;
  let doctorProfileId: string;
  let cardiologyId: string;
  let dermatologyId: string;
  let neurologyId: string;

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
    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.installEmailCapture(emailedTokens);
    app = appModule.createApp();
    prisma = dbModule.prisma;

    const fixture = await import('./helpers/fixtures.mjs');
    cardiologyId = await fixture.makeSpecialty(prisma, `Cardiology ${runId}`);
    dermatologyId = await fixture.makeSpecialty(prisma, `Dermatology ${runId}`);
    neurologyId = await fixture.makeSpecialty(prisma, `Neurology ${runId}`);
    const doctor = await fixture.makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardiologyId });
    await prisma.doctorSpecialty.create({ data: { doctorProfileId: doctor.profileId, specialtyId: dermatologyId } });
    doctorProfileId = doctor.profileId;
    doctorToken = doctor.accessToken;
    const admin = await fixture.makeAdmin(app, prisma, emailedTokens, runId);
    adminToken = admin.accessToken;
    adminUserId = admin.userId;
  }, 180_000);

  afterAll(async () => {
    const fixtureModule = await import('./helpers/fixtures.mjs');
    await fixtureModule.resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  describe('Issue #280: Specialty verification auditing and reviewer identity', () => {
    it('derives reviewer from auth, sets reviewDate server-side, and writes an AuditEvent', async () => {
      const verify = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${cardiologyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'verified', reviewer: 'spoofed-client-reviewer' });
      expect(verify.status).toBe(200);
      expect(verify.body.verificationStatus).toBe('verified');

      const cardio = await prisma.doctorSpecialty.findUniqueOrThrow({
        where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId: cardiologyId } },
      });
      expect(cardio.verificationStatus).toBe('verified');
      expect(cardio.reviewer).toBe(adminUserId);
      expect(cardio.reviewDate).toBeTruthy();

      const audit = await prisma.auditEvent.findFirst({
        where: {
          entityType: 'DoctorSpecialty',
          entityId: cardio.id,
          action: 'doctor_specialty.verification_changed',
        },
      });
      expect(audit).toBeTruthy();
      expect(audit!.actorUserId).toBe(adminUserId);
      expect(audit!.actorRole).toBe('admin');
      expect(audit!.fromState).toBe('pending');
      expect(audit!.toState).toBe('verified');
    });

    it('requires rejectionReason when status is rejected', async () => {
      const noReason = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${dermatologyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected' });
      expect(noReason.status).toBe(400);

      const emptyReason = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${dermatologyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected', rejectionReason: '   ' });
      expect(emptyReason.status).toBe(400);

      const tooLongReason = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${dermatologyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected', rejectionReason: 'a'.repeat(201) });
      expect(tooLongReason.status).toBe(400);

      const reject = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${dermatologyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected', rejectionReason: 'insufficient docs' });
      expect(reject.status).toBe(200);
      expect(reject.body.verificationStatus).toBe('rejected');
      expect(reject.body.rejectionReason).toBe('insufficient docs');

      const derm = await prisma.doctorSpecialty.findUniqueOrThrow({
        where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId: dermatologyId } },
      });
      expect(derm.reviewer).toBe(adminUserId);
      expect(derm.reviewDate).toBeTruthy();

      const audit = await prisma.auditEvent.findFirst({
        where: {
          entityType: 'DoctorSpecialty',
          entityId: derm.id,
          action: 'doctor_specialty.verification_changed',
          toState: 'rejected',
        },
      });
      expect(audit).toBeTruthy();
      expect((audit!.metadata as any)?.rejectionReason).toBe('insufficient docs');
    });

    it('is a no-op when status is unchanged and writes no new AuditEvent', async () => {
      const derm = await prisma.doctorSpecialty.findUniqueOrThrow({
        where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId: dermatologyId } },
      });
      const beforeCount = await prisma.auditEvent.count({
        where: { entityType: 'DoctorSpecialty', entityId: derm.id },
      });

      const res = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${dermatologyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'rejected', rejectionReason: 'same rejection' });
      expect(res.status).toBe(200);

      const afterCount = await prisma.auditEvent.count({
        where: { entityType: 'DoctorSpecialty', entityId: derm.id },
      });
      expect(afterCount).toBe(beforeCount);
    });

    it('returns 404 for unassigned specialty', async () => {
      const missingSpecialtyId = '00000000-0000-4000-8000-000000000099';
      const res = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${missingSpecialtyId}/verification`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'verified' });
      expect(res.status).toBe(404);
    });

    it('requires admin role', async () => {
      const unauth = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${cardiologyId}/verification`)
        .send({ status: 'verified' });
      expect(unauth.status).toBe(401);

      const forbidden = await request(app)
        .patch(`/doctors/${doctorProfileId}/specialties/${cardiologyId}/verification`)
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ status: 'verified' });
      expect(forbidden.status).toBe(403);
    });
  });

  describe('Issue #279: Updating doctor specialties preserves existing verifications', () => {
    it('verified specialty survives adding another; removed specialty is deleted; re-added starts pending', async () => {
      // 1. Doctor currently has verified cardiology and rejected dermatology.
      // Now doctor updates specialties to: [cardiologyId, neurologyId]
      const update1 = await request(app)
        .put('/doctors/me/specialties')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ specialtyIds: [cardiologyId, neurologyId] });
      expect(update1.status).toBe(200);

      const rowsAfterAdd = await prisma.doctorSpecialty.findMany({ where: { doctorProfileId } });
      const cardio = rowsAfterAdd.find((r) => r.specialtyId === cardiologyId);
      const neuro = rowsAfterAdd.find((r) => r.specialtyId === neurologyId);
      const derm = rowsAfterAdd.find((r) => r.specialtyId === dermatologyId);

      // Verified cardiology survived with its verification state intact
      expect(cardio).toBeDefined();
      expect(cardio!.verificationStatus).toBe('verified');
      expect(cardio!.reviewer).toBe(adminUserId);

      // Newly added neurology starts pending
      expect(neuro).toBeDefined();
      expect(neuro!.verificationStatus).toBe('pending');

      // Removed dermatology is gone
      expect(derm).toBeUndefined();

      // 2. Doctor re-adds dermatology
      const update2 = await request(app)
        .put('/doctors/me/specialties')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ specialtyIds: [cardiologyId, neurologyId, dermatologyId] });
      expect(update2.status).toBe(200);

      const rowsAfterReAdd = await prisma.doctorSpecialty.findMany({ where: { doctorProfileId } });
      const reAddedDerm = rowsAfterReAdd.find((r) => r.specialtyId === dermatologyId);
      expect(reAddedDerm).toBeDefined();
      // Re-added dermatology starts as pending, NOT rejected
      expect(reAddedDerm!.verificationStatus).toBe('pending');
      expect(reAddedDerm!.reviewer).toBeNull();
    });
  });

  describe('Issue #282: Admin specialty catalog management', () => {
    let createdSpecialtyId: string;
    const testSlug = `oncology-${runId}`;

    it('allows admin to create a new specialty with audit', async () => {
      const res = await request(app)
        .post('/admin/specialties')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Oncology ${runId}`, slug: testSlug });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe(`Oncology ${runId}`);
      expect(res.body.slug).toBe(testSlug);
      expect(res.body.isRetired).toBe(false);
      createdSpecialtyId = res.body.id;

      const audit = await prisma.auditEvent.findFirst({
        where: {
          entityType: 'Specialty',
          entityId: createdSpecialtyId,
          action: 'specialty.created',
        },
      });
      expect(audit).toBeTruthy();
      expect(audit!.actorUserId).toBe(adminUserId);
    });

    it('rejects duplicate name or slug with 409', async () => {
      const dupName = await request(app)
        .post('/admin/specialties')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Oncology ${runId}`, slug: `other-slug-${runId}` });
      expect(dupName.status).toBe(409);

      const dupSlug = await request(app)
        .post('/admin/specialties')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: `Different Name ${runId}`, slug: testSlug });
      expect(dupSlug.status).toBe(409);
    });

    it('allows admin to rename a specialty while slug stays immutable', async () => {
      const renamedName = `Medical Oncology ${runId}`;
      const res = await request(app)
        .patch(`/admin/specialties/${createdSpecialtyId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: renamedName, slug: 'attempted-slug-change' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe(renamedName);
      expect(res.body.slug).toBe(testSlug); // slug was not changed!

      const audit = await prisma.auditEvent.findFirst({
        where: {
          entityType: 'Specialty',
          entityId: createdSpecialtyId,
          action: 'specialty.renamed',
        },
      });
      expect(audit).toBeTruthy();
      expect(audit!.fromState).toBe(`Oncology ${runId}`);
      expect(audit!.toState).toBe(renamedName);
    });

    it('allows admin to retire a specialty, hiding it from public list', async () => {
      const retireRes = await request(app)
        .post(`/admin/specialties/${createdSpecialtyId}/retire`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(retireRes.status).toBe(200);
      expect(retireRes.body.isRetired).toBe(true);

      const audit = await prisma.auditEvent.findFirst({
        where: {
          entityType: 'Specialty',
          entityId: createdSpecialtyId,
          action: 'specialty.retired',
        },
      });
      expect(audit).toBeTruthy();

      // GET /specialties does not list retired specialties
      const publicList = await request(app).get('/specialties');
      expect(publicList.status).toBe(200);
      const foundInPublic = publicList.body.find((s: any) => s.id === createdSpecialtyId);
      expect(foundInPublic).toBeUndefined();

      // GET /admin/specialties lists all specialties including retired
      const adminList = await request(app)
        .get('/admin/specialties')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminList.status).toBe(200);
      const foundInAdmin = adminList.body.find((s: any) => s.id === createdSpecialtyId);
      expect(foundInAdmin).toBeDefined();
      expect(foundInAdmin.isRetired).toBe(true);

      // A doctor cannot newly assign a retired specialty
      const assignRetired = await request(app)
        .put('/doctors/me/specialties')
        .set('Authorization', `Bearer ${doctorToken}`)
        .send({ specialtyIds: [cardiologyId, createdSpecialtyId] });
      expect(assignRetired.status).toBe(400);
    });
  });

  describe('Issue #281: Admin verification queue', () => {
    let unverifiedDoctorId: string;
    let deactivatedDoctorId: string;

    beforeAll(async () => {
      // Create a pending doctor profile
      const user1 = await prisma.user.create({
        data: {
          role: 'doctor',
          email: `pending-doc-${runId}@example.com`,
          passwordHash: 'dummy',
        },
      });
      const pendingDoc = await prisma.doctorProfile.create({
        data: {
          userId: user1.id,
          fullName: 'Pending Doctor',
          verificationStatus: 'pending',
          timeZone: 'Europe/London',
        },
      });
      await prisma.doctorSpecialty.create({
        data: {
          doctorProfileId: pendingDoc.id,
          specialtyId: neurologyId,
          verificationStatus: 'pending',
        },
      });
      unverifiedDoctorId = pendingDoc.id;

      // Create a deactivated doctor profile
      const user2 = await prisma.user.create({
        data: {
          role: 'doctor',
          email: `deact-doc-${runId}@example.com`,
          passwordHash: 'dummy',
          deactivatedAt: new Date(),
        },
      });
      const deactDoc = await prisma.doctorProfile.create({
        data: {
          userId: user2.id,
          fullName: 'Deactivated Doctor',
          verificationStatus: 'pending',
          timeZone: 'Europe/London',
        },
      });
      await prisma.doctorSpecialty.create({
        data: {
          doctorProfileId: deactDoc.id,
          specialtyId: cardiologyId,
          verificationStatus: 'pending',
        },
      });
      deactivatedDoctorId = deactDoc.id;
    });

    it('requires admin access', async () => {
      const unauth = await request(app).get('/admin/doctors/verification-queue');
      expect(unauth.status).toBe(401);

      const forbidden = await request(app)
        .get('/admin/doctors/verification-queue')
        .set('Authorization', `Bearer ${doctorToken}`);
      expect(forbidden.status).toBe(403);
    });

    it('lists pending profiles and specialties ordered oldest first', async () => {
      const res = await request(app)
        .get('/admin/doctors/verification-queue')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThan(0);

      // Verify oldest first ordering
      for (let i = 1; i < res.body.items.length; i++) {
        const prev = new Date(res.body.items[i - 1].createdAt).getTime();
        const curr = new Date(res.body.items[i].createdAt).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }

      // Deactivated doctor is flagged
      const deactItem = res.body.items.find((item: any) => item.doctorProfileId === deactivatedDoctorId);
      expect(deactItem).toBeDefined();
      expect(deactItem.isDeactivated).toBe(true);

      // Active doctor is not flagged as deactivated
      const activeItem = res.body.items.find((item: any) => item.doctorProfileId === unverifiedDoctorId);
      expect(activeItem).toBeDefined();
      expect(activeItem.isDeactivated).toBe(false);
    });

    it('filters by kind (profile vs specialty)', async () => {
      const profilesOnly = await request(app)
        .get('/admin/doctors/verification-queue?kind=profile')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(profilesOnly.status).toBe(200);
      expect(profilesOnly.body.items.every((item: any) => item.kind === 'profile')).toBe(true);

      const specialtiesOnly = await request(app)
        .get('/admin/doctors/verification-queue?kind=specialty')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(specialtiesOnly.status).toBe(200);
      expect(specialtiesOnly.body.items.every((item: any) => item.kind === 'specialty')).toBe(true);
    });

    it('filters by specialty', async () => {
      const res = await request(app)
        .get(`/admin/doctors/verification-queue?specialty=${neurologyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(
        res.body.items.every((item: any) =>
          item.requestedSpecialties.some((s: any) => s.id === neurologyId || s.slug === neurologyId),
        ),
      ).toBe(true);
    });

    it('supports keyset pagination', async () => {
      const page1 = await request(app)
        .get('/admin/doctors/verification-queue?limit=1')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(page1.status).toBe(200);
      expect(page1.body.items.length).toBe(1);

      if (page1.body.nextCursor) {
        const page2 = await request(app)
          .get(`/admin/doctors/verification-queue?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(page2.status).toBe(200);
        expect(page2.body.items.length).toBe(1);
        expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
      }
    });
  });
});
