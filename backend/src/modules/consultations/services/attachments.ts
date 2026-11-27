import crypto from 'node:crypto';
import { config } from '../../../config';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import {
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
  sniffAttachmentContentType,
  stripImageMetadata,
  type AllowedAttachmentContentType,
} from '../../../utils/image-metadata';
import { getObjectStorage, type StoredObject } from '../../../utils/object-storage';
import * as consultationsRepo from '../repositories';
import { signAttachmentToken, verifyAttachmentToken } from '../signed-url';

export interface AttachmentUploadInput {
  fileName: string;
  contentType: string;
  dataBase64: string;
}

export interface PreparedAttachment {
  objectKey: string;
  fileName: string;
  contentType: AllowedAttachmentContentType;
  sizeBytes: number;
}

function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? 'attachment';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'attachment';
}

function decodeBase64(raw: string): Buffer {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    throw new HttpError('ATTACHMENT_INVALID_BASE64', 'Attachment data must be valid base64.');
  }
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length === 0) {
    throw new HttpError('ATTACHMENT_INVALID_BASE64', 'Attachment data must be valid base64.');
  }
  return buffer;
}

/**
 * Validates and sanitises every attachment before anything is stored
 * (issue #62): size cap, declared type allowlist, byte-level type sniffing
 * (the declared type must match), then EXIF/text-metadata stripping for
 * images. SVG and executables never pass the sniff.
 */
export function prepareAttachments(inputs: AttachmentUploadInput[]): Array<PreparedAttachment & { body: Buffer }> {
  if (inputs.length > config.consultations.attachmentMaxPerMessage) {
    throw new HttpError(
      'ATTACHMENT_TOO_MANY',
      `A message may carry at most ${config.consultations.attachmentMaxPerMessage} attachments.`);
  }

  return inputs.map((input) => {
    const declared = input.contentType.toLowerCase().split(';')[0].trim();
    if (!(ALLOWED_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(declared)) {
      throw new HttpError('ATTACHMENT_TYPE_NOT_ALLOWED', 'Only JPEG, PNG and PDF attachments are accepted.');
    }

    const raw = decodeBase64(input.dataBase64);
    if (raw.length > config.consultations.attachmentMaxBytes) {
      throw new HttpError(
        'ATTACHMENT_TOO_LARGE',
        `An attachment may be at most ${config.consultations.attachmentMaxBytes} bytes.`);
    }

    const sniffed = sniffAttachmentContentType(raw);
    if (!sniffed || sniffed !== declared) {
      throw new HttpError(
        'ATTACHMENT_CONTENT_MISMATCH',
        'Attachment content does not match its declared type.');
    }

    const body = stripImageMetadata(raw, sniffed);
    return {
      body,
      objectKey: `consultations/${crypto.randomUUID()}`,
      fileName: sanitizeFileName(input.fileName),
      contentType: sniffed,
      sizeBytes: body.length,
    };
  });
}

/** Per-user quota (issue #62), measured over messages the user sent. The
 * quota is a product guard, not a security boundary; two concurrent uploads
 * can overshoot it by at most one message's worth. */
export function assertWithinQuota(existingBytes: number, addedBytes: number): void {
  if (existingBytes + addedBytes > config.consultations.attachmentQuotaBytes) {
    throw new HttpError('ATTACHMENT_QUOTA_EXCEEDED', 'Attachment storage quota exceeded.');
  }
}

/** Writes the prepared bytes. Object keys are opaque and never returned. */
export async function storeAttachmentObjects(
  prepared: Array<PreparedAttachment & { body: Buffer }>,
): Promise<void> {
  const storage = getObjectStorage();
  for (const item of prepared) {
    await storage.putObject({ key: item.objectKey, body: item.body, contentType: item.contentType });
  }
}

export async function userAttachmentBytes(userId: string): Promise<number> {
  return consultationsRepo.sumAttachmentBytesForUser(prisma, userId);
}

/** Serves a signed download. The signature and expiry are the whole
 * authorisation here — this is what makes the minted URL short-lived and
 * unguessable without being a long-lived public link. */
export async function readSignedAttachment(
  attachmentId: string,
  expiresAtMs: number,
  signature: string,
): Promise<{ attachment: { fileName: string; contentType: string; sizeBytes: number }; object: StoredObject }> {
  if (!verifyAttachmentToken(attachmentId, expiresAtMs, signature)) {
    throw new HttpError('ATTACHMENT_LINK_INVALID', 'This download link is invalid or has expired.');
  }
  const attachment = await consultationsRepo.findAttachmentById(prisma, attachmentId);
  if (!attachment) throw new HttpError('ATTACHMENT_NOT_FOUND', 'Attachment not found.');

  const object = await getObjectStorage().getObject(attachment.objectKey);
  if (!object) throw new HttpError('ATTACHMENT_FILE_NOT_FOUND', 'Attachment file not found.');
  return { attachment, object };
}

export interface AttachmentDownloadLink {
  url: string;
  expiresAt: string;
}

/** Mints the short-lived signed URL. The caller has already proven thread
 * membership; the token carries only the attachment id and expiry. */
export function createDownloadLink(attachmentId: string, baseUrl: string): AttachmentDownloadLink {
  const expiresAtMs = Date.now() + config.consultations.attachmentUrlTtlSeconds * 1000;
  const signature = signAttachmentToken(attachmentId, expiresAtMs);
  const path = `/consultations/messages/attachments/${encodeURIComponent(attachmentId)}/file`;
  return {
    url: `${baseUrl.replace(/\/$/, '')}${path}?expires=${expiresAtMs}&signature=${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}
