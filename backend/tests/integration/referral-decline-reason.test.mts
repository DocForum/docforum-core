// Issue #309: capture an optional reason when a patient declines a referral.
//
// Covers the whole decline write path — the endpoint's backwards-compatible
// empty body, the structured enum reason, the bounded free-text note, the
// validation rejections, the AuditEvent metadata (and its 200-character
// bound), and the referring doctor seeing the reason via GET /referrals/created.
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
const PORT = 5477;
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

type App = ReturnType<typeof import('../../src/app.js').createApp>;

function decline(
  app: App,
  patient: { accessToken: string },
  referralId: string,
  body?: unknown,
) {
  const call = request(app)
    .post(`/referrals/${referralId}/decline`)
    .set('Authorization', `Bearer ${patient.accessToken}`);
  // Omitting `.send()` entirely is the "no body" backwards-compatibility case.
  return body === undefined ? call : call.send(body as object);
}

describe('patient declines a referral with an optional reason (issue #309)', () => {
  let app: App;
  let prisma: typeof import('../../src/db/prisma-client.js').prisma;
  const emailedTokens = new Map<string, string>();
  let targetId: string;
  let referringDoctor: Awaited<ReturnType<typeof makeDoctor>>;
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
    targetId = await makeSpecialty(prisma, `Decline Reason Target ${runId}`);
    referringDoctor = await makeDoctor(app, prisma, emailedTokens, runId);
    targetDoctor = await makeDoctor(app, prisma, emailedTokens, runId + 1, { specialtyId: targetId });
    patient = await makePatient(app, emailedTokens, runId);
  });

  afterAll(async () => {
    await resetEmailSenderFixture();
    await prisma?.$disconnect();
    await pg.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function pendingReferral(notes = 'Decline me.') {
    const { consultationId } = await consultationRitual(app, patient, referringDoctor);
    const created = await createReferral(app, referringDoctor, {
      sourceConsultationId: consultationId,
      targetDoctorId: targetDoctor.profileId,
      snapshotNotes: notes,
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  async function declineEvents(referralId: string) {
    return prisma.auditEvent.findMany({
      where: { entityType: 'Referral', entityId: referralId, action: 'referral.declined' },
    });
  }

  it('declines without a body, preserving the original behaviour (no reason stored)', async () => {
    const referralId = await pendingReferral();

    const res = await decline(app, patient, referralId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('declined');
    expect(res.body.declineReason).toBeNull();
    expect(res.body.declineReasonNote).toBeNull();

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.status).toBe('declined');
    expect(stored.declineReason).toBeNull();
    expect(stored.declineReasonNote).toBeNull();

    const events = await declineEvents(referralId);
    expect(events).toHaveLength(1);
    expect(events[0].fromState).toBe('pending');
    expect(events[0].toState).toBe('declined');
    expect(events[0].actorUserId).toBe(patient.userId);
    expect(events[0].metadata).toEqual({ patientProfileId: patient.profileId });
  });

  it('stores a structured enum reason only', async () => {
    const referralId = await pendingReferral();

    const res = await decline(app, patient, referralId, { reason: { enum: 'cost' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('declined');
    expect(res.body.declineReason).toBe('cost');
    expect(res.body.declineReasonNote).toBeNull();

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.declineReason).toBe('cost');
    expect(stored.declineReasonNote).toBeNull();

    const [event] = await declineEvents(referralId);
    const metadata = event.metadata as { patientProfileId?: string; declineReason?: string; declineReasonText?: string };
    expect(metadata.patientProfileId).toBe(patient.profileId);
    expect(metadata.declineReason).toBe('cost');
    expect(metadata.declineReasonText).toBeUndefined();
  });

  it('stores an enum reason plus a bounded free-text note, recording both in the audit metadata', async () => {
    const referralId = await pendingReferral();
    const note = 'Too expensive for my current budget.';

    const res = await decline(app, patient, referralId, {
      reason: { enum: 'cost', note },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('declined');
    expect(res.body.declineReason).toBe('cost');
    expect(res.body.declineReasonNote).toBe(note);

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.declineReason).toBe('cost');
    expect(stored.declineReasonNote).toBe(note);

    const [event] = await declineEvents(referralId);
    const metadata = event.metadata as { declineReason?: string; declineReasonText?: string };
    expect(metadata.declineReason).toBe('cost');
    expect(metadata.declineReasonText).toBe(note);
    // The audit module rejects any metadata string over 200 characters.
    expect((metadata.declineReasonText as string).length).toBeLessThanOrEqual(200);
  });

  it('records a note at the 200-character bound intact', async () => {
    const referralId = await pendingReferral();
    const note = 'x'.repeat(200);

    const res = await decline(app, patient, referralId, { reason: { enum: 'other', note } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.declineReasonNote).toBe(note);

    const [event] = await declineEvents(referralId);
    expect((event.metadata as { declineReasonText?: string }).declineReasonText).toBe(note);
  });

  it('trims a blank note to null instead of storing whitespace', async () => {
    const referralId = await pendingReferral();

    const res = await decline(app, patient, referralId, {
      reason: { enum: 'distance', note: '   ' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.declineReason).toBe('distance');
    expect(stored.declineReasonNote).toBeNull();

    const [event] = await declineEvents(referralId);
    const metadata = event.metadata as { declineReason?: string; declineReasonText?: string };
    expect(metadata.declineReason).toBe('distance');
    expect(metadata.declineReasonText).toBeUndefined();
  });

  it('rejects an invalid enum or an over-long note without changing the referral', async () => {
    const referralId = await pendingReferral();

    const invalidBodies = [
      { reason: { enum: 'too_expensive' } },
      { reason: { note: 'no enum supplied' } },
      { reason: { enum: 'cost', note: 'y'.repeat(201) } },
    ];
    for (const body of invalidBodies) {
      const res = await decline(app, patient, referralId, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.status).toBe('pending');
    expect(stored.declineReason).toBeNull();
    expect(stored.declineReasonNote).toBeNull();
    expect(await declineEvents(referralId)).toHaveLength(0);
  });

  it('exposes the decline reason to the referring doctor in GET /referrals/created', async () => {
    const referralId = await pendingReferral('Reason visible to the referrer.');
    const note = 'I would prefer a second opinion first.';

    const declined = await decline(app, patient, referralId, {
      reason: { enum: 'second_opinion', note },
    });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);

    const created = await request(app)
      .get('/referrals/created')
      .set('Authorization', `Bearer ${referringDoctor.accessToken}`);
    expect(created.status).toBe(200);

    const row = (
      created.body as {
        id: string;
        status: string;
        declineReason: string | null;
        declineReasonNote: string | null;
      }[]
    ).find((item) => item.id === referralId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('declined');
    expect(row!.declineReason).toBe('second_opinion');
    expect(row!.declineReasonNote).toBe(note);
  });

  it('rejects declining a referral that is no longer pending, leaving the stored reason untouched', async () => {
    const referralId = await pendingReferral();

    const first = await decline(app, patient, referralId, { reason: { enum: 'cost' } });
    expect(first.status).toBe(200);

    const second = await decline(app, patient, referralId, {
      reason: { enum: 'distance', note: 'changed my mind' },
    });
    expect(second.status).toBe(409);

    const stored = await prisma.referral.findUniqueOrThrow({ where: { id: referralId } });
    expect(stored.declineReason).toBe('cost');
    expect(stored.declineReasonNote).toBeNull();
    expect(await declineEvents(referralId)).toHaveLength(1);
  });
});
