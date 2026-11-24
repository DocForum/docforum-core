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
const PORT = 5487;
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

function withdraw(
  app: ReturnType<typeof import('../../src/app.js').createApp>,
  doctor: { accessToken: string },
  referralId: string,
  reason: string,
) {
  return request(app)
    .post(`/referrals/${referralId}/withdraw`)
    .set('Authorization', `Bearer ${doctor.accessToken}`)
    .send({ reason });
}

describe('referring doctor withdraws a pending referral', () => {
  let app: ReturnType<typeof import('../../src/app.js').createApp>;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let targetId: string;
  let referringDoctor: Awaited<ReturnType<typeof makeDoctor>>;
  let otherDoctor: Awaited<ReturnType<typeof makeDoctor>>;
  let targetDoctor: Awaited<ReturnType<typeof makeDoctor>>;
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

    process.env.DATABASE_URL = databaseUrl;

    const appModule = await import('../../src/app.js');
    const dbModule = await import('../../src/db/prisma-client.js');
    app = appModule.createApp();
    prisma = dbModule.prisma;

    await installEmailCapture(emailedTokens);
    targetId = await makeSpecialty(prisma, `Withdraw Target ${runId}`);
    referringDoctor = await makeDoctor(app, prisma, emailedTokens, runId);
    otherDoctor = await makeDoctor(app, prisma, emailedTokens, runId + 1);
    targetDoctor = await makeDoctor(app, prisma, emailedTokens, runId + 2, { specialtyId: targetId });
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function pendingReferral(notes = 'Withdraw me.') {
    const { consultationId } = await consultationRitual(app, patient, referringDoctor);
    const created = await createReferral(app, referringDoctor, {
      sourceConsultationId: consultationId,
      targetDoctorId: targetDoctor.profileId,
      snapshotNotes: notes,
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  it('withdraws a pending referral with a bounded reason, audited in the same trail', async () => {
    const referralId = await pendingReferral();
    const reason = 'Referred by mistake; condition resolved.';

    const res = await withdraw(app, referringDoctor, referralId, reason);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledReason).toBe(reason);
    expect(res.body.resultingAppointmentId).toBeNull();

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.status).toBe('cancelled');
    expect(stored.cancelledReason).toBe(reason);

    const events = await prisma.auditEvent.findMany({
      where: { entityType: 'Referral', entityId: referralId, action: 'referral.withdraw' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].fromState).toBe('pending');
    expect(events[0].toState).toBe('cancelled');
    expect(events[0].actorUserId).toBe(referringDoctor.userId);
    expect(events[0].actorRole).toBe('doctor');
    expect((events[0].metadata as { reason?: string } | null)?.reason).toBe(reason);
  });

  it('requires a reason and refuses an over-long one without changing the referral', async () => {
    const referralId = await pendingReferral();

    for (const body of [{}, { reason: '   ' }, { reason: 'x'.repeat(201) }]) {
      const res = await request(app)
        .post(`/referrals/${referralId}/withdraw`)
        .set('Authorization', `Bearer ${referringDoctor.accessToken}`)
        .send(body);
      expect(res.status).toBe(400);
    }

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.status).toBe('pending');
    expect(stored.cancelledReason).toBeNull();
    expect(await prisma.auditEvent.count({ where: { entityId: referralId, action: 'referral.withdraw' } })).toBe(0);
  });

  it('returns 404 for another doctor’s referral or an unknown id', async () => {
    const referralId = await pendingReferral();

    const foreign = await withdraw(app, otherDoctor, referralId, 'Not mine.');
    expect(foreign.status).toBe(404);
    const unknown = await withdraw(app, referringDoctor, '00000000-0000-0000-0000-000000000000', 'Unknown.');
    expect(unknown.status).toBe(404);

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.status).toBe('pending');
    expect(await prisma.auditEvent.count({ where: { entityId: referralId, action: 'referral.withdraw' } })).toBe(0);
  });

  it('refuses to withdraw an accepted referral', async () => {
    const referralId = await pendingReferral();
    const slots = await generateSlots(app, targetDoctor, 1);
    const accepted = await acceptReferral(app, patient, referralId, slots[0]);
    expect(accepted.status).toBe(200);

    const res = await withdraw(app, referringDoctor, referralId, 'Too late.');
    expect(res.status).toBe(409);

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.status).toBe('accepted');
    expect(stored.cancelledReason).toBeNull();
    expect(await prisma.auditEvent.count({ where: { entityId: referralId, action: 'referral.withdraw' } })).toBe(0);
  });

  it('lets exactly one of a concurrent withdraw and accept win, for every pairing', async () => {
    const pairs: { referralId: string; slotId: string }[] = [];
    for (let index = 0; index < 4; index += 1) {
      const referralId = await pendingReferral(`Race ${index}.`);
      const [slotId] = await generateSlots(app, targetDoctor, 1);
      pairs.push({ referralId, slotId });
    }

    const results = await Promise.all(
      pairs.flatMap(({ referralId, slotId }) => [
        withdraw(app, referringDoctor, referralId, 'Concurrent withdrawal.'),
        acceptReferral(app, patient, referralId, slotId),
      ]),
    );

    for (const [index, { referralId }] of pairs.entries()) {
      const withdrawResult = results[index * 2];
      const acceptResult = results[index * 2 + 1];
      expect([withdrawResult.status, acceptResult.status].sort()).toEqual([200, 409]);

      const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
      const appointments = await prisma.appointment.findMany({ where: { referralId } });
      const withdrawEvents = await prisma.auditEvent.count({
        where: { entityType: 'Referral', entityId: referralId, action: 'referral.withdraw' },
      });
      const acceptEvents = await prisma.auditEvent.count({
        where: { entityType: 'Referral', entityId: referralId, action: 'referral.accepted' },
      });

      if (withdrawResult.status === 200) {
        expect(stored.status).toBe('cancelled');
        expect(stored.cancelledReason).toBe('Concurrent withdrawal.');
        expect(stored.resultingAppointmentId).toBeNull();
        expect(appointments).toHaveLength(0);
        expect(withdrawEvents).toBe(1);
        expect(acceptEvents).toBe(0);
      } else {
        expect(stored.status).toBe('accepted');
        expect(stored.resultingAppointmentId).toBe(appointments[0]?.id);
        expect(appointments).toHaveLength(1);
        expect(withdrawEvents).toBe(0);
        expect(acceptEvents).toBe(1);
      }
    }
  });
});
