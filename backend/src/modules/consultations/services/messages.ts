import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { decryptField, encryptField } from '../../../utils/field-encryption';
import { publish } from '../../../events';
import * as auditService from '../../audit/services';
import * as consultationsRepo from '../repositories';
import { assertThreadOpen, resolveThreadContext } from './access';
import {
  assertWithinQuota,
  prepareAttachments,
  storeAttachmentObjects,
  userAttachmentBytes,
  type AttachmentUploadInput,
} from './attachments';

export interface PostMessageInput {
  body?: string;
  attachments?: AttachmentUploadInput[];
}

const MAX_PAGE_SIZE = 100;

function viewAttachment(attachment: {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}) {
  // Never expose objectKey: the file is only reachable through the signed
  // download endpoint (issue #62).
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt,
  };
}

/**
 * Appends a message to a consultation thread (issue #61). Only the
 * appointment's patient or treating doctor may post; the write is refused
 * once the thread's closing window has passed. The body is PHI: encrypted at
 * rest and never logged.
 *
 * Attachment bytes are stripped and stored before the transaction; the
 * message, attachment rows, audit event and notification outbox event then
 * commit together. A storage failure aborts before anything is written; a
 * failure after storage can leave an unreferenced object, which is harmless
 * (keys are opaque) and is the documented trade-off of never deleting a
 * message's bytes.
 */
export async function postMessage(
  actor: auditService.AuditActor,
  consultationId: string,
  input: PostMessageInput,
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const context = await resolveThreadContext(actor.userId, consultationId);
  assertThreadOpen(context.consultation);

  const body = input.body?.trim() ?? '';
  const uploads = input.attachments ?? [];
  if (body.length === 0 && uploads.length === 0) {
    throw new HttpError(400, 'A message needs text or at least one attachment.');
  }

  const prepared = prepareAttachments(uploads);
  if (prepared.length > 0) {
    const existing = await userAttachmentBytes(actor.userId);
    assertWithinQuota(existing, prepared.reduce((sum, item) => sum + item.sizeBytes, 0));
    await storeAttachmentObjects(prepared);
  }

  const recipientUserId = context.role === 'doctor' ? context.patientUserId : context.doctorUserId;

  const created = await prisma.$transaction(async (tx) => {
    const message = await consultationsRepo.createMessage(tx, {
      consultationId,
      senderUserId: actor.userId!,
      senderRole: context.role,
      body: encryptField(body) ?? '',
    });

    const attachments = [];
    for (const attachment of prepared) {
      attachments.push(
        await consultationsRepo.createAttachment(tx, {
          messageId: message.id,
          objectKey: attachment.objectKey,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          sizeBytes: attachment.sizeBytes,
        }),
      );
    }

    await auditService.record(tx, actor, {
      entityType: 'Consultation',
      entityId: consultationId,
      action: 'consultation.message_sent',
      fromState: null,
      toState: null,
      metadata: { messageId: message.id, senderRole: context.role, attachmentCount: prepared.length },
    });

    // Phase 6 hook point: consumers can turn this into a notification once
    // the provider work lands. Recording it in the outbox here means the
    // thread does not depend on Phase 6 existing.
    await publish(tx, 'consultation.message.created', {
      consultationId,
      messageId: message.id,
      senderUserId: actor.userId!,
      recipientUserId: recipientUserId ?? null,
    });

    return { message, attachments };
  });

  return {
    ...created.message,
    body,
    attachments: created.attachments.map(viewAttachment),
  };
}

/** One keyset page of the thread, oldest first. Returns decrypted bodies and
 * attachment metadata (no keys, no URLs). */
export async function listMessages(
  userId: string,
  consultationId: string,
  options: { cursor?: string; limit?: number },
) {
  await resolveThreadContext(userId, consultationId);

  const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_PAGE_SIZE);
  const rows = await consultationsRepo.findMessagesPage(prisma, consultationId, options.cursor, limit + 1);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1]!.id : null;

  return {
    messages: page.map((row) => ({
      id: row.id,
      senderRole: row.senderRole,
      body: decryptField(row.body) ?? '',
      createdAt: row.createdAt,
      attachments: row.attachments.map(viewAttachment),
    })),
    nextCursor,
  };
}

/** Authorises a download and mints the short-lived signed URL (issue #62). */
export async function authorizeAttachmentDownload(
  userId: string,
  attachmentId: string,
  buildLink: (attachmentId: string) => { url: string; expiresAt: string },
) {
  const attachment = await consultationsRepo.findAttachmentById(prisma, attachmentId);
  if (!attachment) throw new HttpError(404, 'Attachment not found.');

  const context = await resolveThreadContext(userId, attachment.message.consultationId);
  auditService.recordAccess({
    accessedBy: userId,
    patientProfileId: context.consultation.appointment.patientProfileId,
    entityType: 'Consultation',
    entityId: context.consultation.id,
    route: 'GET /consultations/messages/attachments/:id/download-url',
    detail: 'attachment download link',
  });

  return { attachment, link: buildLink(attachment.id) };
}

/** Looks up an attachment for the signed endpoint. Authorisation already
 * happened when the link was minted; the token's expiry bounds it. */
export async function getAttachmentForSignedDownload(attachmentId: string) {
  const attachment = await consultationsRepo.findAttachmentById(prisma, attachmentId);
  if (!attachment) throw new HttpError(404, 'Attachment not found.');
  return attachment;
}
