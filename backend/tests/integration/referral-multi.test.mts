// Multiple simultaneous referrals from one consultation (issue #66, PRD
// §8.2.4): atomic all-or-none batch creation, one snapshot copy per
// target, duplicate-specialty rejection, independent acceptance. Port 5442.
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
  generateSlots,
  installEmailCapture,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5447;
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

describe('multiple simultaneous referrals from one consultation', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let gp: Awaited<ReturnType<typeof makeDoctor>>;
  let cardio: Awaited<ReturnType<typeof makeDoctor>>;
  let endo: Awaited<ReturnType<typeof makeDoctor>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;
  let cardioSpecialtyId: string;
  let endoSpecialtyId: string;

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
    endoSpecialtyId = await makeSpecialty(prisma, `Endocrinology ${runId}`);
    gp = await makeDoctor(app, prisma, emailedTokens, runId);
    cardio = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardioSpecialtyId });
    endo = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: endoSpecialtyId });
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function postBatch(consultationId: string, targets: unknown[]) {
    return request(app)
      .post(`/consultations/${consultationId}/referrals`)
      .set('Authorization', `Bearer ${gp.accessToken}`)
      .send({ targets });
  }

  it('creates a batch atomically, each target with its own snapshot copy', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await postBatch(consultationId, [
      { targetDoctorId: cardio.profileId, targetSpecialtyId: cardioSpecialtyId, snapshotNotes: 'Cardio notes' },
      { targetDoctorId: endo.profileId, targetSpecialtyId: endoSpecialtyId, snapshotNotes: 'Endo notes' },
    ]);
    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    const [first, second] = res.body as { snapshotNotes: string; sourceConsultationId: string; id: string }[];
    expect(first.snapshotNotes).toBe('Cardio notes');
    expect(second.snapshotNotes).toBe('Endo notes');
    expect(first.id).not.toBe(second.id);
    expect(first.sourceConsultationId).toBe(consultationId);
    expect(second.sourceConsultationId).toBe(consultationId);
  });

  it('rejects two targets of the same specialty and rolls back the whole batch', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const before = await prisma.referral.count({ where: { sourceConsultationId: consultationId } });
    const res = await postBatch(consultationId, [
      { targetDoctorId: cardio.profileId, targetSpecialtyId: cardioSpecialtyId, snapshotNotes: 'A' },
      { targetDoctorId: cardio.profileId, targetSpecialtyId: cardioSpecialtyId, snapshotNotes: 'B' },
    ]);
    expect(res.status).toBe(422);
    const after = await prisma.referral.count({ where: { sourceConsultationId: consultationId } });
    expect(after).toBe(before); // first target rolled back with the second
  });

  it('rolls back the first target when a later target fails validation', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const unverified = await makeDoctor(app, prisma, emailedTokens, runId + 1);
    await prisma.doctorProfile.update({
      where: { id: unverified.profileId },
      data: { verificationStatus: 'pending' },
    });
    const res = await postBatch(consultationId, [
      { targetDoctorId: cardio.profileId, targetSpecialtyId: cardioSpecialtyId, snapshotNotes: 'valid first' },
      { targetDoctorId: unverified.profileId, snapshotNotes: 'invalid second' },
    ]);
    expect(res.status).toBe(422);
    const rows = await prisma.referral.findMany({ where: { sourceConsultationId: consultationId } });
    expect(rows).toHaveLength(0);
  });

  it('rejects a batch target that duplicates a referral already made from the consultation', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const single = await request(app)
      .post('/referrals')
      .set('Authorization', `Bearer ${gp.accessToken}`)
      .send({
        sourceConsultationId: consultationId,
        targetDoctorId: cardio.profileId,
        targetSpecialtyId: cardioSpecialtyId,
        snapshotNotes: 'earlier single',
      });
    expect(single.status).toBe(201);

    const res = await postBatch(consultationId, [
      { targetDoctorId: endo.profileId, targetSpecialtyId: endoSpecialtyId, snapshotNotes: 'new one' },
      { targetDoctorId: cardio.profileId, targetSpecialtyId: cardioSpecialtyId, snapshotNotes: 'duplicate' },
    ]);
    expect(res.status).toBe(409);
    const rows = await prisma.referral.findMany({
      where: { sourceConsultationId: consultationId, snapshotNotes: 'new one' },
    });
    expect(rows).toHaveLength(0); // batch rolled back despite valid first target
  });

  it('acceptance is independent per referral in the bundle', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await postBatch(consultationId, [
      { targetDoctorId: cardio.profileId, targetSpecialtyId: cardioSpecialtyId, snapshotNotes: 'accept me' },
      { targetDoctorId: endo.profileId, targetSpecialtyId: endoSpecialtyId, snapshotNotes: 'leave me pending' },
    ]);
    expect(res.status).toBe(201);
    const [first, second] = res.body as { id: string; status: string }[];

    const cardioSlots = await generateSlots(app, cardio, 2);
    const accepted = await acceptReferral(app, patient, first.id, cardioSlots[0]);
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');

    const stillPending = await prisma.referral.findUniqueOrThrow({ where: { id: second.id } });
    expect(stillPending.status).toBe('pending');

    // The patient's list groups the bundle by consultation.
    const list = await request(app)
      .get('/referrals/mine')
      .set('Authorization', `Bearer ${patient.accessToken}`);
    const group = (list.body.groupedByConsultation as Record<string, { id: string }[]>)[consultationId];
    expect(group).toHaveLength(2);
  });

  it('rejects an empty target list', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await postBatch(consultationId, []);
    expect(res.status).toBe(400); // zod: at least one target required
  });
});
