// Referral loop detection and maximum-hop limit (issue #65, PRD §8.1.2):
// lineage via parentReferralId, strict revisit flagging, bounded chain
// walk, admin queue visibility. Port 5443.
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
  makeAdmin,
  makeDoctor,
  makePatient,
  makeSpecialty,
  resetEmailSenderFixture,
  setAppointmentStatus,
} from './helpers/fixtures.mjs';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5443;
const runId = Date.now();
const REFERRAL_MAX_HOPS = 4;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-test-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});
const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_test`;

describe('referral loop detection', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let gp: Awaited<ReturnType<typeof makeDoctor>>;
  let cardio: Awaited<ReturnType<typeof makeDoctor>>;
  let endo: Awaited<ReturnType<typeof makeDoctor>>;
  let patient: Awaited<ReturnType<typeof makePatient>>;
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
    const endoSpecialtyId = await makeSpecialty(prisma, `Endocrinology ${runId}`);
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

  /** Continue the chain: patient sees `from`, completes the (fresh or
   * referral-origin) appointment, `from` refers onward to `to`. Returns
   * the new referral. */
  async function hopAndRefer(
    from: { accessToken: string; profileId: string },
    to: { profileId: string },
    viaConsultationAppointmentId?: string,
  ) {
    let consultationId: string;
    if (viaConsultationAppointmentId) {
      const completed = await setAppointmentStatus(app, from, viaConsultationAppointmentId, 'completed');
      expect(completed.status).toBe(200);
      const consult = await request(app)
        .post('/consultations')
        .set('Authorization', `Bearer ${from.accessToken}`)
        .send({ appointmentId: viaConsultationAppointmentId, outcome: 'resolved' });
      expect(consult.status).toBe(201);
      consultationId = consult.body.id as string;
    } else {
      ({ consultationId } = await consultationRitual(app, patient, from as never));
    }
    const res = await createReferral(app, from, {
      sourceConsultationId: consultationId,
      targetDoctorId: to.profileId,
      snapshotNotes: 'chain hop',
    });
    return res;
  }

  /** Accept `referralId` with a slot of its target doctor, returning the
   * resulting appointment id. */
  async function acceptAndGetAppointment(
    referralId: string,
    target: { accessToken: string; profileId: string },
  ) {
    const slots = await generateSlots(app, target, 2);
    const accepted = await acceptReferral(app, patient, referralId, slots[0]);
    expect(accepted.status).toBe(200);
    return accepted.body.resultingAppointmentId as string;
  }

  it('A→B→A is created but flagged for the admin queue (strict rule: even a GP return)', async () => {
    const r1 = await hopAndRefer(gp, cardio);
    expect(r1.status).toBe(201);
    const r1Appointment = await acceptAndGetAppointment(r1.body.id, cardio);

    // Cardio refers BACK to the GP — legitimate clinically maybe, but the
    // strict rule flags it; a human decides.
    const r2 = await hopAndRefer(cardio, gp, r1Appointment);
    expect(r2.status).toBe(201);
    expect(r2.body.parentReferralId).toBe(r1.body.id);
    expect(r2.body.loopFlaggedAt).toBeTruthy();
    expect(r2.body.loopFlagReason).toContain('chain');

    const row = await prisma.referral.findUniqueOrThrow({ where: { id: r2.body.id } });
    expect(row.loopFlaggedAt).not.toBeNull();
    // Still created — pending, not rejected.
    expect(row.status).toBe('pending');
  });

  it('A→B→C→A flags the third hop', async () => {
    const r1 = await hopAndRefer(gp, cardio);
    const r1Appointment = await acceptAndGetAppointment(r1.body.id, cardio);
    const r2 = await hopAndRefer(cardio, endo, r1Appointment);
    expect(r2.body.loopFlaggedAt).toBeNull();
    const r2Appointment = await acceptAndGetAppointment(r2.body.id, endo);

    const r3 = await hopAndRefer(endo, gp, r2Appointment);
    expect(r3.status).toBe(201);
    expect(r3.body.parentReferralId).toBe(r2.body.id);
    expect(r3.body.loopFlaggedAt).toBeTruthy();
  });

  it(`rejects a referral that would exceed the ${REFERRAL_MAX_HOPS}-hop limit`, async () => {
    // R1: gp → cardio (hop 1)
    const r1 = await hopAndRefer(gp, cardio);
    const a1 = await acceptAndGetAppointment(r1.body.id, cardio);

    // Intermediates with distinct profiles so only DEPTH trips the guard.
    const hopDoctors: Awaited<ReturnType<typeof makeDoctor>>[] = [];
    for (let i = 0; i < 4; i++) {
      hopDoctors.push(await makeDoctor(app, prisma, emailedTokens, runId + 10 + i));
    }

    // R2: cardio → hop0 (hop 2)
    const r2 = await hopAndRefer(cardio, hopDoctors[0], a1);
    expect(r2.body.loopFlaggedAt).toBeNull();
    const a2 = await acceptAndGetAppointment(r2.body.id, hopDoctors[0]);

    // R3: hop0 → hop1 (hop 3)
    const r3 = await hopAndRefer(hopDoctors[0], hopDoctors[1], a2);
    expect(r3.body.loopFlaggedAt).toBeNull();
    const a3 = await acceptAndGetAppointment(r3.body.id, hopDoctors[1]);

    // R4: hop1 → hop2 (hop 4 — the last allowed)
    const r4 = await hopAndRefer(hopDoctors[1], hopDoctors[2], a3);
    expect(r4.status).toBe(201);
    const a4 = await acceptAndGetAppointment(r4.body.id, hopDoctors[2]);

    // R5: hop2 → hop3 would be hop 5 — hard reject.
    const r5 = await hopAndRefer(hopDoctors[2], hopDoctors[3], a4);
    expect(r5.status).toBe(422);
    expect(r5.body.message).toMatch(/maximum of 4 hops/i);

    const count = await prisma.referral.count({
      where: { targetDoctorId: hopDoctors[3].profileId },
    });
    expect(count).toBe(0);
  });

  it('surfaces flagged referrals in the admin queue', async () => {
    const admin = await makeAdmin(app, prisma, emailedTokens, runId);

    const r1 = await hopAndRefer(gp, cardio);
    const a1 = await acceptAndGetAppointment(r1.body.id, cardio);
    const flagged = await hopAndRefer(cardio, gp, a1);
    expect(flagged.body.loopFlaggedAt).toBeTruthy();

    const queue = await request(app)
      .get('/referrals/admin/queue?loopFlagged=true')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(queue.status).toBe(200);
    const ids = (queue.body as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(flagged.body.id);
    const flaggedRow = (queue.body as { id: string; reason: string }[]).find(
      (row) => row.id === flagged.body.id,
    );
    expect(flaggedRow?.reason).toBeTruthy();
  });

  it('a non-admin cannot read the admin queue', async () => {
    const queue = await request(app)
      .get('/referrals/admin/queue')
      .set('Authorization', `Bearer ${gp.accessToken}`);
    expect(queue.status).toBe(403);
  });
});
