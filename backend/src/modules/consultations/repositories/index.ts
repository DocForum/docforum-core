import { prisma } from '../../../db/prisma-client';
import type {
  Consultation,
  ConsultationAddendum,
  ConsultationMessage,
  ConsultationMessageSenderRole,
  ConsultationOutcome,
  FollowUpStatus,
  Prisma,
} from '@prisma/client';

type DbClient = typeof prisma | Prisma.TransactionClient;

export function createConsultation(
  db: DbClient,
  data: { appointmentId: string; outcome: Consultation['outcome']; notes: string | null },
): Promise<Consultation> {
  return db.consultation.create({ data });
}

/** One consultation per appointment (the unique index is the guarantee —
 * this read is only for callers that need the row without a write). */
export function findConsultationByAppointmentId(
  db: DbClient,
  appointmentId: string,
): Promise<Consultation | null> {
  return db.consultation.findUnique({ where: { appointmentId } });
}

export function findConsultationById(db: DbClient, id: string) {
  return db.consultation.findUnique({
    where: { id },
    include: {
      appointment: true,
      referrals: true,
      addenda: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
}

/** Issue #64: notes only change while the record is unsigned. One conditional
 * UPDATE — the DB trigger is the second line of defence. */
export function updateNotesIfUnsigned(db: DbClient, id: string, notes: string) {
  return db.consultation.updateMany({
    where: { id, signedAt: null },
    data: { notes },
  });
}

/** Issue #64: signing is once-only. Zero rows means it was already signed. */
export function markSignedIfUnsigned(db: DbClient, id: string, signedAt: Date) {
  return db.consultation.updateMany({
    where: { id, signedAt: null },
    data: { signedAt },
  });
}

/** Auto sign-off sweep: notes untouched for the configured grace period. */
export function signOffUnsignedClosedBefore(db: DbClient, closedBefore: Date, signedAt: Date) {
  return db.consultation.updateMany({
    where: { signedAt: null, createdAt: { lt: closedBefore } },
    data: { signedAt },
  });
}

// --- Issue #61: message thread ------------------------------------------

export function createMessage(
  db: DbClient,
  data: {
    consultationId: string;
    senderUserId: string;
    senderRole: ConsultationMessageSenderRole;
    body: string;
  },
): Promise<ConsultationMessage> {
  return db.consultationMessage.create({ data });
}

export function findMessageById(db: DbClient, id: string) {
  return db.consultationMessage.findUnique({ where: { id } });
}

/** One keyset page, oldest first. A cursor is a message id; the compound
 * order makes (createdAt, id) unique for pagination. */
export function findMessagesPage(
  db: DbClient,
  consultationId: string,
  cursorId: string | undefined,
  take: number,
) {
  return db.consultationMessage.findMany({
    where: { consultationId },
    include: { attachments: { orderBy: { createdAt: 'asc' } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
  });
}

export function createAttachment(
  db: DbClient,
  data: { messageId: string; objectKey: string; fileName: string; contentType: string; sizeBytes: number },
) {
  return db.consultationMessageAttachment.create({ data });
}

export function findAttachmentById(db: DbClient, id: string) {
  return db.consultationMessageAttachment.findUnique({
    where: { id },
    include: { message: { select: { consultationId: true, senderUserId: true } } },
  });
}

/** Per-user storage total, over messages that user sent (issue #62). */
export async function sumAttachmentBytesForUser(db: DbClient, userId: string): Promise<number> {
  const result = await db.consultationMessageAttachment.aggregate({
    _sum: { sizeBytes: true },
    where: { message: { senderUserId: userId } },
  });
  return result._sum.sizeBytes ?? 0;
}

// --- Issue #64: addenda -------------------------------------------------

export function createAddendum(
  db: DbClient,
  data: { consultationId: string; authorUserId: string; body: string },
): Promise<ConsultationAddendum> {
  return db.consultationAddendum.create({ data });
}

export function findAddenda(db: DbClient, consultationId: string) {
  return db.consultationAddendum.findMany({
    where: { consultationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

// --- Issue #63: follow-up requests --------------------------------------

export function createFollowUpRequest(
  db: DbClient,
  data: {
    consultationId: string;
    doctorProfileId: string;
    patientProfileId: string;
    notesSnapshot: string | null;
    intakeFormId: string | null;
    windowStart: Date;
    windowEnd: Date;
  },
) {
  return db.followUpRequest.create({ data });
}

export function findFollowUpById(db: DbClient, id: string) {
  return db.followUpRequest.findUnique({ where: { id }, include: { consultation: true } });
}

export function findFollowUpsForPatient(db: DbClient, patientProfileId: string, status?: FollowUpStatus) {
  return db.followUpRequest.findMany({
    where: { patientProfileId, ...(status ? { status } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

/** Claims an open follow-up exactly once (concurrency guard for booking). */
export function claimOpenFollowUp(db: DbClient, id: string) {
  return db.followUpRequest.updateMany({
    where: { id, status: 'open' },
    data: { status: 'booked' },
  });
}

export function attachBookedAppointment(db: DbClient, id: string, appointmentId: string) {
  return db.followUpRequest.update({ where: { id }, data: { bookedAppointmentId: appointmentId } });
}

export function expireFollowUpsPastWindow(db: DbClient, now: Date) {
  return db.followUpRequest.updateMany({
    where: { status: 'open', windowEnd: { lt: now } },
    data: { status: 'expired' },
  });
}

/** Latest intake the patient completed, if any. Best effort: Appointment has
 * no intake FK yet (issue #2), so a follow-up carries the link itself. */
export function findLatestIntakeForPatient(db: DbClient, patientProfileId: string) {
  return db.intakeForm.findFirst({
    where: { patientProfileId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
}

/** One keyset page of a patient's consultations for the data export
 * (issue #40): the note, its addenda, the thread and the follow-up request. */
export function findConsultationsPageForPatient(patientProfileId: string, cursor: string | undefined, take: number) {
  return prisma.consultation.findMany({
    where: { appointment: { patientProfileId } },
    include: {
      messages: { include: { attachments: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      addenda: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      followUp: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export function findConsultationsPage(
  db: DbClient,
  input: {
    appointmentIds: string[];
    before?: { createdAt: Date; id: string };
    take: number;
  },
) {
  return db.consultation.findMany({
    where: {
      appointmentId: { in: input.appointmentIds },
      ...(input.before
        ? {
            OR: [
              { createdAt: { lt: input.before.createdAt } },
              { createdAt: input.before.createdAt, id: { lt: input.before.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      appointmentId: true,
      outcome: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.take,
  });
}

/**
 * Conditional update that closes an open consultation only if outcome IS NULL.
 * Returns the updated row or null if already closed.
 */
export async function closeOpenConsultation(
  db: DbClient,
  where: { appointmentId: string },
  data: { outcome: ConsultationOutcome; notes?: string | null },
): Promise<Consultation | null> {
  let count: number;
  if (data.notes !== undefined) {
    count = await db.$executeRaw`
      UPDATE "Consultation"
      SET "outcome" = ${data.outcome}::"ConsultationOutcome",
          "notes" = ${data.notes},
          "updatedAt" = NOW()
      WHERE "appointmentId" = ${where.appointmentId}
        AND "outcome" IS NULL
    `;
  } else {
    count = await db.$executeRaw`
      UPDATE "Consultation"
      SET "outcome" = ${data.outcome}::"ConsultationOutcome",
          "updatedAt" = NOW()
      WHERE "appointmentId" = ${where.appointmentId}
        AND "outcome" IS NULL
    `;
  }
  if (count === 0) {
    return null;
  }
  return db.consultation.findUnique({ where: { appointmentId: where.appointmentId } });
}
