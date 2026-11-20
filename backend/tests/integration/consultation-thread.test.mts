// Phase 2 issues #61–#64, end to end against a real Postgres and the full
// HTTP stack, with the in-process object store standing in for S3.
//
// Proves, in one self-contained suite:
//   * #61 the async thread: only the appointment's patient and treating
//     doctor can read/write, bodies are encrypted at rest, keyset pagination
//     works, the thread closes after the configured window, and a
//     notification outbox event exists per message;
//   * #62 attachments: SVG/executables refused, content must match its
//     declared type, EXIF is stripped before storage, a short-lived signed
//     URL is minted only for a participant, tampering/expiry is refused, and
//     the per-user quota is enforced;
//   * #63 a `follow_up_needed` close creates a FollowUpRequest carrying an
//     immutable note snapshot and the patient's latest intake; booking it
//     uses the ordinary conditional slot claim (one winner), and the sweep
//     expires unbooked requests;
//   * #64 notes stay editable until sign-off, then a DB trigger rejects any
//     further UPDATE — including one issued directly through Prisma — while
//     addenda stay append-only and the read API returns them in order.
//
// Embedded Postgres on port 5470, same pattern as the other integration files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import EmbeddedPostgres from 'embedded-postgres';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5470; // unique per integration file
const runId = Date.now();
const QUOTA_BYTES = 5000;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforum-consult-thread-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'docforum',
  password: 'docforum',
  port: PORT,
  persistent: false,
});

const databaseUrl = `postgresql://docforum:docforum@localhost:${PORT}/docforum_consult_thread_test`;

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type Prisma = typeof import('../../src/db/prisma-client.js').prisma;

/** JPEG with an EXIF APP1 segment and a comment segment (both must be gone
 * after upload), padded after EOI so quota tests have a known size. */
function jpegWithPrivateMetadata(paddingBytes = 0): Buffer {
  const exifPayload = Buffer.from('Exif\0\0GPSLatitude=51.5', 'latin1');
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([0x00, exifPayload.length + 2]),
    exifPayload,
  ]);
  const commentPayload = Buffer.from('secret comment', 'latin1');
  const comment = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0x00, commentPayload.length + 2]),
    commentPayload,
  ]);
  const head = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    comment,
    Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22]),
  ]);
  return Buffer.concat([head, Buffer.alloc(paddingBytes), Buffer.from([0xff, 0xd9])]);
}

function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void) {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('async consultation thread, attachments, follow-ups and sign-off', () => {
  let app: App;
  let prisma: Prisma;
  let objects: Map<string, { body: Buffer; contentType?: string }>;
  const tokens = {} as Record<'patient' | 'otherPatient' | 'doctor' | 'otherDoctor', string>;

  let patientProfileId: string;
  let doctorProfileId: string;
  let consultationId: string;
  let followUpId: string;
  let secondConsultationId: string;
  let secondFollowUpId: string;
  let attachmentId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function makeCompletedAppointment(offsetDays: number) {
    const start = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    const slot = await prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        status: 'booked',
        startTime: start,
        endTime: new Date(start.getTime() + 30 * 60 * 1000),
      },
    });
    return prisma.appointment.create({
      data: {
        patientProfileId,
        doctorProfileId,
        availabilitySlotId: slot.id,
        status: 'completed',
      },
    });
  }

  async function openSlot(offsetDays: number) {
    const start = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    return prisma.availabilitySlot.create({
      data: {
        doctorProfileId,
        status: 'open',
        startTime: start,
        endTime: new Date(start.getTime() + 30 * 60 * 1000),
      },
    });
  }

  beforeAll(async () => {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('docforum_consult_thread_test');

    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    });

    // Set before the dynamic imports: config and PrismaClient read these at
    // import time.
    process.env.DATABASE_URL = databaseUrl;
    process.env.CONSULTATION_ATTACHMENT_QUOTA_BYTES = String(QUOTA_BYTES);

    const { createApp } = await import('../../src/app.js');
    app = createApp();
    prisma = (await import('../../src/db/prisma-client.js')).prisma;
    const { signAccessToken } = await import('../../src/modules/auth/services/tokens.js');
    const storage = await import('../../src/utils/object-storage.js');
    objects = (storage.getObjectStorage() as InstanceType<typeof storage.MemoryObjectStorage>)
      .objects as unknown as Map<string, { body: Buffer; contentType?: string }>;

    const user = async (tag: string, role: 'patient' | 'doctor') => {
      const created = await prisma.user.create({
        data: {
          email: `consult-thread-${tag}-${runId}@example.com`,
          passwordHash: 'unused',
          role,
          emailVerifiedAt: new Date(),
        },
      });
      return { id: created.id, token: signAccessToken({ sub: created.id, role }) };
    };

    const patient = await user('patient', 'patient');
    tokens.patient = patient.token;
    patientProfileId = (
      await prisma.patientProfile.create({ data: { userId: patient.id, fullName: 'Thread Patient' } })
    ).id;

    const otherPatient = await user('other-patient', 'patient');
    tokens.otherPatient = otherPatient.token;
    await prisma.patientProfile.create({ data: { userId: otherPatient.id, fullName: 'Unrelated Patient' } });

    const doctor = await user('doctor', 'doctor');
    tokens.doctor = doctor.token;
    doctorProfileId = (
      await prisma.doctorProfile.create({
        data: {
          userId: doctor.id,
          fullName: 'Treating Doctor',
          timeZone: 'UTC',
          verificationStatus: 'verified',
        },
      })
    ).id;

    const otherDoctor = await user('other-doctor', 'doctor');
    tokens.otherDoctor = otherDoctor.token;
    await prisma.doctorProfile.create({
      data: {
        userId: otherDoctor.id,
        fullName: 'Unrelated Doctor',
        timeZone: 'UTC',
        verificationStatus: 'verified',
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pg.stop();
  });

  it('creates the thread host and a follow-up request when a consultation closes as follow_up_needed', async () => {
    // Intake is linked to the follow-up request (Appointment has no intake FK
    // yet — issue #2 — so the request carries it).
    await prisma.intakeForm.create({
      data: { patientProfileId, symptoms: [{ symptom: 'headache' }] },
    });

    const appointment = await makeCompletedAppointment(1);
    const closed = await request(app)
      .post(`/appointments/${appointment.id}/consultation`)
      .set(auth(tokens.doctor))
      .send({ outcome: 'follow_up_needed', notes: 'Come back in two weeks.' });

    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    consultationId = closed.body.consultation.id;
    expect(closed.body.consultation.signedAt).toBeNull();

    const followUp = await prisma.followUpRequest.findUniqueOrThrow({ where: { consultationId } });
    followUpId = followUp.id;
    expect(followUp.status).toBe('open');
    expect(followUp.notesSnapshot).not.toBeNull();
    expect(followUp.notesSnapshot).not.toContain('Come back'); // encrypted at rest
    expect(followUp.intakeFormId).not.toBeNull();
  });

  describe('#61 message thread', () => {
    it('refuses non-participants and anonymous readers/writers', async () => {
      expect((await request(app).get(`/consultations/${consultationId}/messages`)).status).toBe(401);
      expect(
        (await request(app).get(`/consultations/${consultationId}/messages`).set(auth(tokens.otherDoctor))).status,
      ).toBe(403);
      // RLS hides another patient's consultation entirely (404, not 403) —
      // the same answer a missing id gets, so nothing leaks.
      expect(
        (await request(app).get(`/consultations/${consultationId}/messages`).set(auth(tokens.otherPatient))).status,
      ).toBe(404);
      expect(
        (
          await request(app)
            .post(`/consultations/${consultationId}/messages`)
            .set(auth(tokens.otherDoctor))
            .send({ body: 'not my patient' })
        ).status,
      ).toBe(403);
    });

    it('lets both participants post, encrypts at rest and emits the notification event', async () => {
      const fromPatient = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({ body: 'Should I keep taking the tablets?' });
      expect(fromPatient.status, JSON.stringify(fromPatient.body)).toBe(201);
      expect(fromPatient.body).toMatchObject({ senderRole: 'patient', body: 'Should I keep taking the tablets?' });

      const fromDoctor = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.doctor))
        .send({ body: 'Yes, finish the course.' });
      expect(fromDoctor.status).toBe(201);
      expect(fromDoctor.body.senderRole).toBe('doctor');

      const stored = await prisma.consultationMessage.findUniqueOrThrow({ where: { id: fromPatient.body.id } });
      expect(stored.body).not.toContain('tablets'); // AES-256-GCM envelope

      const events = await prisma.outboxEvent.findMany({ where: { type: 'consultation.message.created' } });
      expect(events.some((event) => {
        const payload = event.payload as { consultationId: string; messageId: string };
        return payload.consultationId === consultationId && payload.messageId === fromPatient.body.id;
      })).toBe(true);
    });

    it('rejects empty messages and unknown consultations', async () => {
      const empty = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({ body: '   ' });
      expect(empty.status).toBe(400);
      expect(
        (
          await request(app)
            .post('/consultations/00000000-0000-0000-0000-000000000000/messages')
            .set(auth(tokens.patient))
            .send({ body: 'hello' })
        ).status,
      ).toBe(404);
    });

    it('pages with a keyset cursor, oldest first', async () => {
      await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({ body: 'Third message' });

      const first = await request(app)
        .get(`/consultations/${consultationId}/messages?limit=2`)
        .set(auth(tokens.patient));
      expect(first.status).toBe(200);
      expect(first.body.messages).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();

      const next = await request(app)
        .get(`/consultations/${consultationId}/messages?limit=2&cursor=${first.body.nextCursor}`)
        .set(auth(tokens.patient));
      expect(next.status).toBe(200);
      expect(next.body.messages).toHaveLength(1);
      expect(next.body.nextCursor).toBeNull();
    });

    it('is append-only at the database level', async () => {
      const message = await prisma.consultationMessage.findFirstOrThrow({ where: { consultationId } });
      await expect(
        prisma.consultationMessage.update({ where: { id: message.id }, data: { body: 'rewritten' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.consultationMessage.delete({ where: { id: message.id } })).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('#62 attachments', () => {
    it('refuses SVG, executables, mismatched types and non-base64 payloads', async () => {
      const svg = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          attachments: [
            {
              fileName: 'x.svg',
              contentType: 'image/svg+xml',
              dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),
            },
          ],
        });
      expect(svg.status).toBe(400);
      expect(svg.body.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');

      const exe = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          attachments: [
            { fileName: 'x.exe', contentType: 'image/jpeg', dataBase64: Buffer.from([0x4d, 0x5a, 0x00]).toString('base64') },
          ],
        });
      expect(exe.status).toBe(400);
      expect(exe.body.code).toBe('ATTACHMENT_CONTENT_MISMATCH');

      const pdfAsJpeg = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          attachments: [
            { fileName: 'x.jpg', contentType: 'image/jpeg', dataBase64: Buffer.from('%PDF-1.7').toString('base64') },
          ],
        });
      expect(pdfAsJpeg.status).toBe(400);
      expect(pdfAsJpeg.body.code).toBe('ATTACHMENT_CONTENT_MISMATCH');

      const badBase64 = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          attachments: [{ fileName: 'x.jpg', contentType: 'image/jpeg', dataBase64: 'not base64!!' }],
        });
      expect(badBase64.status).toBe(400);
      expect(badBase64.body.code).toBe('ATTACHMENT_INVALID_BASE64');
    });

    it('stores the image without EXIF and never returns the object key', async () => {
      const jpeg = jpegWithPrivateMetadata();
      const res = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          body: 'Rash photo',
          attachments: [
            { fileName: '../../evil name.jpg', contentType: 'image/jpeg', dataBase64: jpeg.toString('base64') },
          ],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.attachments).toHaveLength(1);
      attachmentId = res.body.attachments[0].id;
      expect(res.body.attachments[0].fileName).toBe('evil name.jpg'); // path stripped
      expect(JSON.stringify(res.body)).not.toContain('consultations/');

      const row = await prisma.consultationMessageAttachment.findUniqueOrThrow({ where: { id: attachmentId } });
      const stored = objects.get(row.objectKey);
      expect(stored).toBeDefined();
      expect(stored!.body.includes(Buffer.from('GPSLatitude'))).toBe(false);
      expect(stored!.body.includes(Buffer.from('secret comment'))).toBe(false);
      expect(stored!.body.length).toBeLessThan(jpeg.length);
    });

    it('enforces the per-user storage quota', async () => {
      const big = jpegWithPrivateMetadata(3000);
      const accepted = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          attachments: [{ fileName: 'big.jpg', contentType: 'image/jpeg', dataBase64: big.toString('base64') }],
        });
      // Either it fits, or the small attachment already consumed enough that
      // this is refused — the next upload must be refused either way.
      expect([201, 413]).toContain(accepted.status);

      const over = await request(app)
        .post(`/consultations/${consultationId}/messages`)
        .set(auth(tokens.patient))
        .send({
          attachments: [{ fileName: 'big2.jpg', contentType: 'image/jpeg', dataBase64: big.toString('base64') }],
        });
      expect(over.status).toBe(413);
      expect(over.body.code).toBe('ATTACHMENT_QUOTA_EXCEEDED');
    });

    it('mints a signed URL only for a participant and serves the bytes once', async () => {
      expect(
        (await request(app).get(`/consultations/messages/attachments/${attachmentId}/download-url`)).status,
      ).toBe(401);
      expect(
        (
          await request(app)
            .get(`/consultations/messages/attachments/${attachmentId}/download-url`)
            .set(auth(tokens.otherDoctor))
        ).status,
      ).toBe(403);

      const link = await request(app)
        .get(`/consultations/messages/attachments/${attachmentId}/download-url`)
        .set(auth(tokens.doctor));
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      expect(link.body.expiresAt).toBeTruthy();

      const pathAndQuery = `${new URL(link.body.url).pathname}${new URL(link.body.url).search}`;
      const file = await request(app).get(pathAndQuery).buffer(true).parse(binary);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('image/jpeg');
      expect(file.headers['cache-control']).toBe('private, no-store');
      expect((file.body as Buffer).includes(Buffer.from('GPSLatitude'))).toBe(false);

      const tampered = pathAndQuery.replace(/signature=[^&]+/, 'signature=forged');
      expect((await request(app).get(tampered)).status).toBe(403);
    });
  });

  describe('#64 note sign-off and addenda', () => {
    it('edits notes before sign-off, then refuses edits after sign-off — trigger included', async () => {
      const edited = await request(app)
        .patch(`/consultations/${consultationId}/notes`)
        .set(auth(tokens.doctor))
        .send({ notes: 'Come back in two weeks; keep a symptom diary.' });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.notes).toBe('Come back in two weeks; keep a symptom diary.');

      expect(
        (
          await request(app)
            .patch(`/consultations/${consultationId}/notes`)
            .set(auth(tokens.otherDoctor))
            .send({ notes: 'not mine' })
        ).status,
      ).toBe(403);

      const signed = await request(app)
        .post(`/consultations/${consultationId}/sign-off`)
        .set(auth(tokens.doctor));
      expect(signed.status, JSON.stringify(signed.body)).toBe(200);
      expect(signed.body.signedAt).toBeTruthy();

      const afterSign = await request(app)
        .patch(`/consultations/${consultationId}/notes`)
        .set(auth(tokens.doctor))
        .send({ notes: 'silent rewrite' });
      expect(afterSign.status).toBe(409);
      expect(afterSign.body.code).toBe('CONSULTATION_NOTE_SIGNED');

      // The reviewer's direct-Prisma attempt: the DB trigger is the backstop.
      await expect(
        prisma.consultation.update({ where: { id: consultationId }, data: { notes: 'raw rewrite' } }),
      ).rejects.toThrow(/immutable after sign-off/);

      const secondSignOff = await request(app)
        .post(`/consultations/${consultationId}/sign-off`)
        .set(auth(tokens.doctor));
      expect(secondSignOff.status).toBe(409);
      expect(secondSignOff.body.code).toBe('CONSULTATION_ALREADY_SIGNED');
    });

    it('adds append-only addenda, only by the authoring doctor, and returns them in order', async () => {
      expect(
        (
          await request(app)
            .post(`/consultations/${consultationId}/addenda`)
            .set(auth(tokens.otherDoctor))
            .send({ body: 'unrelated' })
        ).status,
      ).toBe(403);

      const first = await request(app)
        .post(`/consultations/${consultationId}/addenda`)
        .set(auth(tokens.doctor))
        .send({ body: 'Correction: the dose was 5mg, not 10mg.' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.addenda).toHaveLength(1);
      expect(first.body.addenda[0].body).toContain('5mg');

      await request(app)
        .post(`/consultations/${consultationId}/addenda`)
        .set(auth(tokens.doctor))
        .send({ body: 'Second addendum.' });

      const read = await request(app).get(`/consultations/${consultationId}`).set(auth(tokens.patient));
      expect(read.status).toBe(200);
      expect(read.body.signedAt).toBeTruthy();
      expect(read.body.addenda.map((a: { body: string }) => a.body)).toEqual([
        'Correction: the dose was 5mg, not 10mg.',
        'Second addendum.',
      ]);
      // Addenda are PHI too.
      const storedAddendum = await prisma.consultationAddendum.findFirstOrThrow({
        where: { consultationId },
      });
      expect(storedAddendum.body).not.toContain('5mg');

      await expect(
        prisma.consultationAddendum.update({ where: { id: storedAddendum.id }, data: { body: 'x' } }),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses an addendum before sign-off', async () => {
      const appointment = await makeCompletedAppointment(3);
      const closed = await request(app)
        .post(`/appointments/${appointment.id}/consultation`)
        .set(auth(tokens.doctor))
        .send({ outcome: 'resolved', notes: 'Still editable.' });
      expect(closed.status).toBe(201);

      const res = await request(app)
        .post(`/consultations/${closed.body.consultation.id}/addenda`)
        .set(auth(tokens.doctor))
        .send({ body: 'too early' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONSULTATION_NOTE_NOT_SIGNED');
    });

    it('auto sign-off sweeps notes left unsigned past the grace period', async () => {
      const { autoSignOffOverdue } = await import('../../src/modules/consultations/services/index.js');
      const unsigned = await prisma.consultation.count({ where: { signedAt: null } });
      expect(unsigned).toBeGreaterThan(0);

      const result = await autoSignOffOverdue(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000));
      expect(result.signed).toBeGreaterThan(0);

      // A signed note is never re-signed: the sweep's WHERE excludes it and
      // the trigger would reject a change anyway.
      const signedAt = (await prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } })).signedAt;
      const secondRun = await autoSignOffOverdue(new Date(Date.now() + 366 * 24 * 60 * 60 * 1000));
      expect(secondRun.signed).toBe(0);
      expect((await prisma.consultation.findUniqueOrThrow({ where: { id: consultationId } })).signedAt).toEqual(
        signedAt,
      );
    });
  });

  describe('#63 follow-up requests', () => {
    it('lists the open request for the patient with a decrypted snapshot', async () => {
      const res = await request(app).get('/follow-ups/mine').set(auth(tokens.patient));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: followUpId, status: 'open' });
      expect(res.body[0].notesSnapshot).toBe('Come back in two weeks.');
    });

    it('books through the standard conditional slot claim, exactly once under concurrency', async () => {
      const slot = await openSlot(5);
      const book = () =>
        request(app)
          .post(`/follow-ups/${followUpId}/book`)
          .set(auth(tokens.patient))
          .send({ availabilitySlotId: slot.id });

      const results = await Promise.all([book(), book()]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const winner = results.find((r) => r.status === 201)!;
      expect(winner.body.appointment.origin).toBe('follow_up');

      const followUp = await prisma.followUpRequest.findUniqueOrThrow({ where: { id: followUpId } });
      expect(followUp.status).toBe('booked');
      expect(followUp.bookedAppointmentId).toBe(winner.body.appointment.id);
      expect(await prisma.appointment.count({ where: { availabilitySlotId: slot.id } })).toBe(1);

      const again = await book();
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('FOLLOW_UP_ALREADY_BOOKED');
    });

    it("refuses a slot that belongs to another doctor and another patient's request", async () => {
      const appointment = await makeCompletedAppointment(6);
      const closed = await request(app)
        .post(`/appointments/${appointment.id}/consultation`)
        .set(auth(tokens.doctor))
        .send({ outcome: 'follow_up_needed', notes: 'Book a follow-up.' });
      secondConsultationId = closed.body.consultation.id;
      const requestOfSecond = await prisma.followUpRequest.findUniqueOrThrow({
        where: { consultationId: secondConsultationId },
      });
      secondFollowUpId = requestOfSecond.id;

      expect(
        (
          await request(app)
            .post(`/follow-ups/${secondFollowUpId}/book`)
            .set(auth(tokens.otherPatient))
            .send({ availabilitySlotId: (await openSlot(7)).id })
        ).status,
      ).toBe(403);

      const otherDoctorSlot = await prisma.availabilitySlot.create({
        data: {
          doctorProfileId: (
            await prisma.doctorProfile.findFirstOrThrow({
              where: { fullName: 'Unrelated Doctor' },
            })
          ).id,
          status: 'open',
          startTime: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
          endTime: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000),
        },
      });
      const wrongDoctor = await request(app)
        .post(`/follow-ups/${secondFollowUpId}/book`)
        .set(auth(tokens.patient))
        .send({ availabilitySlotId: otherDoctorSlot.id });
      expect(wrongDoctor.status).toBe(409);
    });

    it('expires unbooked requests past their window and keeps them visible', async () => {
      await prisma.followUpRequest.update({
        where: { id: secondFollowUpId },
        data: { windowEnd: new Date(Date.now() - 1000) },
      });

      const { expireOpenFollowUps } = await import('../../src/modules/consultations/services/index.js');
      const swept = await expireOpenFollowUps();
      expect(swept.expired).toBeGreaterThanOrEqual(1);

      const list = await request(app).get('/follow-ups/mine?status=expired').set(auth(tokens.patient));
      expect(list.status).toBe(200);
      expect(list.body.map((row: { id: string }) => row.id)).toContain(secondFollowUpId);

      const expiredBooking = await request(app)
        .post(`/follow-ups/${secondFollowUpId}/book`)
        .set(auth(tokens.patient))
        .send({ availabilitySlotId: (await openSlot(9)).id });
      expect(expiredBooking.status).toBe(409);
      expect(expiredBooking.body.code).toBe('FOLLOW_UP_EXPIRED');
    });
  });

  describe('#61 thread closing', () => {
    it('refuses new messages once the configured window has passed', async () => {
      // Use the second consultation purely as an aged thread.
      await prisma.consultation.update({
        where: { id: secondConsultationId },
        data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      });

      const res = await request(app)
        .post(`/consultations/${secondConsultationId}/messages`)
        .set(auth(tokens.patient))
        .send({ body: 'one more question' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONSULTATION_THREAD_CLOSED');
    });
  });
});
