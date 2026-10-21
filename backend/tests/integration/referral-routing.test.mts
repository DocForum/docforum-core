// Referral routing without a target doctor (issue #6, docs/adr/0008):
// a specialty-only target is resolved at creation to the least-loaded
// eligible doctor in that specialty; zero eligible doctors fails the
// creation with 422 and writes nothing; the referring doctor, deactivated
// doctors and unverified doctors are never routed to. Self-contained
// embedded Postgres on port 5448 (see booking.test.mts for the pattern —
// every integration file needs its OWN port).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';
import {
  consultationRitual,
  createReferral,
  installEmailCapture,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5448;
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

describe('referral routing (specialty only)', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();

  let cardiologyId: string;
  let emptySpecialtyId: string;
  let selfOnlySpecialtyId: string;
  let dualSpecialtyId: string;
  let deactivatedSpecialtyId: string;

  let gp: Awaited<ReturnType<typeof makeDoctor>>;
  let cardioA: Awaited<ReturnType<typeof makeDoctor>>;
  let cardioB: Awaited<ReturnType<typeof makeDoctor>>;
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
    emptySpecialtyId = await makeSpecialty(prisma, `Empty ${runId}`);
    selfOnlySpecialtyId = await makeSpecialty(prisma, `Self Only ${runId}`);
    dualSpecialtyId = await makeSpecialty(prisma, `Dual ${runId}`);
    deactivatedSpecialtyId = await makeSpecialty(prisma, `Deactivated ${runId}`);

    gp = await makeDoctor(app, prisma, emailedTokens, runId);
    cardioA = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardiologyId });
    cardioB = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: cardiologyId });
    patient = await makePatient(app, emailedTokens, runId);

    // A doctor who holds the specialty but was never verified: not a
    // routing candidate (PRD FR-3), and the only doctor in
    // emptySpecialtyId, so that specialty has zero eligible recipients.
    const unverified = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: emptySpecialtyId });
    await prisma.doctorProfile.update({
      where: { id: unverified.profileId },
      data: { verificationStatus: 'pending' },
    });

    // The only verified doctor in selfOnlySpecialtyId is the GP who will
    // try to refer into it — self-referral must leave zero candidates.
    await prisma.doctorSpecialty.create({
      data: { doctorProfileId: gp.profileId, specialtyId: selfOnlySpecialtyId },
    });
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('routes a specialty-only referral to the least-loaded eligible doctor', async () => {
    // Load one of the two cardiologists with an explicit referral first,
    // so "least loaded" has something to choose between.
    const loaded = await consultationRitual(app, patient, gp);
    const seeded = await createReferral(app, gp, {
      sourceConsultationId: loaded.consultationId,
      targetDoctorId: cardioA.profileId,
      targetSpecialtyId: cardiologyId,
      snapshotNotes: 'Explicit referral to cardio A.',
    });
    expect(seeded.status).toBe(201);

    const { consultationId } = await consultationRitual(app, patient, gp);
    const routed = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetSpecialtyId: cardiologyId,
      snapshotNotes: 'Needs a cardiologist, any cardiologist.',
    });

    expect(routed.status).toBe(201);
    // cardioA already has one active referral (load 1), cardioB has none.
    expect(routed.body.targetDoctorId).toBe(cardioB.profileId);
    expect(routed.body.targetSpecialtyId).toBe(cardiologyId);
    expect(routed.body.status).toBe('pending');
    expect(routed.body.snapshotNotes).toBe('Needs a cardiologist, any cardiologist.');
    expect(routed.body.referringDoctorId).toBe(gp.profileId);
  });

  it('fails 422 and writes nothing when no verified doctor holds the specialty', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const before = await prisma.referral.count({ where: { sourceConsultationId: consultationId } });

    const res = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetSpecialtyId: emptySpecialtyId,
      snapshotNotes: 'Nobody can take this.',
    });

    expect(res.status).toBe(422);
    // Machine-readable so the referring doctor's UI can say "no specialist
    // available" instead of rendering a generic failure (ADR 0008 §4).
    expect(res.body.code).toBe('REFERRAL_NO_ELIGIBLE_TARGET');
    expect(res.body.message).toMatch(/no verified doctor/i);
    const after = await prisma.referral.count({ where: { sourceConsultationId: consultationId } });
    expect(after).toBe(before);
  });

  it('refuses to route a referral back to the referring doctor', async () => {
    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetSpecialtyId: selfOnlySpecialtyId,
      snapshotNotes: 'This would be a self-referral.',
    });
    expect(res.status).toBe(422);
  });

  it('never routes to a doctor whose account is deactivated', async () => {
    const active = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: deactivatedSpecialtyId });
    const deactivated = await makeDoctor(app, prisma, emailedTokens, runId, {
      specialtyId: deactivatedSpecialtyId,
    });
    // Deactivated with no load, i.e. the candidate the rule would
    // otherwise prefer: the exclusion has to do the work, not the load.
    await prisma.user.update({
      where: { id: deactivated.userId },
      data: { deactivatedAt: new Date() },
    });

    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetSpecialtyId: deactivatedSpecialtyId,
      snapshotNotes: 'Route around the inactive account.',
    });

    expect(res.status).toBe(201);
    expect(res.body.targetDoctorId).toBe(active.profileId);
  });

  it('never routes a specialty target onto a doctor the same batch named explicitly', async () => {
    const doctorBoth = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: dualSpecialtyId });
    const doctorOther = await makeDoctor(app, prisma, emailedTokens, runId, { specialtyId: dualSpecialtyId });

    // Load the only real alternative, so a broken exclusion would pick
    // the explicitly named doctor (load 0) instead of the loaded one.
    const seeded = await consultationRitual(app, patient, gp);
    const seededReferral = await createReferral(app, gp, {
      sourceConsultationId: seeded.consultationId,
      targetDoctorId: doctorOther.profileId,
      targetSpecialtyId: dualSpecialtyId,
      snapshotNotes: 'Load the alternative.',
    });
    expect(seededReferral.status).toBe(201);

    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await request(app)
      .post(`/referrals/from-consultation/${consultationId}`)
      .set('Authorization', `Bearer ${gp.accessToken}`)
      .send({
        targets: [
          { targetSpecialtyId: dualSpecialtyId, snapshotNotes: 'any doctor in this specialty' },
          { targetDoctorId: doctorBoth.profileId, snapshotNotes: 'and specifically this one' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].targetDoctorId).toBe(doctorOther.profileId);
    expect(res.body[1].targetDoctorId).toBe(doctorBoth.profileId);
    expect(res.body[0].targetDoctorId).not.toBe(res.body[1].targetDoctorId);
  });
});
