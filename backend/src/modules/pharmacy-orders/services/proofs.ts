// Fulfillment proof files (issue #316). The legacy fulfill endpoints used to
// accept any client string as `attachmentUrl`; now the proof file itself is
// uploaded — same raw-body pattern as lab results (ADR 0018): a content-type
// allowlist, a size cap (enforced by the route's body parser), a magic-byte
// check and the malware scanner, then a private object-storage key that the
// server generates. Reading it back is access-checked: the order's patient
// (or an active guardian), the facility that recorded the proof, and admins.
// Anyone else gets the same 404 as a missing proof, so ids can't be probed.
//
// Rows written before #316 keep their client-supplied value in
// `legacyAttachmentUrl`; it is untrusted and nothing here ever serves it.
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { config } from '../../../config';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { logger } from '../../../logger';
import { getFileScanner } from '../../../utils/file-scanner';
import { getObjectStorage } from '../../../utils/object-storage';
import * as auditService from '../../audit/services';
import * as facilitiesService from '../../facilities/services';
import * as patientsService from '../../patients/services';
import * as repo from '../repositories';
import { PROOF_FILE_SIGNATURES, assertAcceptableProofFile } from './proof-files';

const NOT_FOUND = 'Fulfillment proof not found.';

export interface ProofAttachmentView {
  proofId: string;
  orderId: string;
  contentType: string;
  byteSize: number;
}

/** `PUT /fulfillment-proofs/:proofId/attachment` — the facility that recorded
 * the proof attaches its file, once. */
export async function attachProofFile(
  actor: auditService.AuditActor,
  proofId: string,
  file: { body: unknown; contentType: string | undefined },
): Promise<ProofAttachmentView> {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const facilityProfileId = await facilitiesService.getOwnFacilityProfileId(actor.userId).catch(() => null);
  const proof = await repo.findFulfillmentProofWithOrder(proofId);
  // Only the facility that recorded the proof may attach; for anyone else
  // the proof does not exist.
  if (!proof || facilityProfileId === null || proof.facilityProfileId !== facilityProfileId) {
    throw new HttpError('PROOF_NOT_FOUND', NOT_FOUND);
  }
  if (proof.attachmentObjectKey) {
    throw new HttpError('PROOF_ALREADY_ATTACHED', 'A file has already been attached to this proof.');
  }

  const { body, contentType } = assertAcceptableProofFile(file);

  const scanResult = await getFileScanner().scan(body);
  if (scanResult === 'infected') {
    throw new HttpError('PROOF_INFECTED', 'The uploaded file was refused by the malware scanner.');
  }
  if (scanResult === 'error') {
    if (!config.fileScanning.failOpen) {
      throw new HttpError('PROOF_SCAN_UNAVAILABLE', 'File scanning is unavailable and this environment requires it to pass.');
    }
    logger.error('[file-scanner] scan error — failing open for fulfillment proof upload');
  }

  // Opaque key: nothing about the patient, order or original filename.
  const objectKey = `fulfillment-proofs/${randomUUID()}`;
  const storage = getObjectStorage();
  await storage.putObject({ key: objectKey, body, contentType });

  try {
    await prisma.$transaction(async (tx) => {
      const attached = await repo.setProofAttachmentIfEmpty(tx, proof.id, {
        objectKey,
        contentType,
        byteSize: body.byteLength,
      });
      if (!attached) {
        throw new HttpError('PROOF_ALREADY_ATTACHED', 'A file has already been attached to this proof.');
      }
      await auditService.record(tx, actor, {
        entityType: 'FulfillmentProof',
        entityId: proof.id,
        action: 'fulfillment_proof.attached',
        fromState: null,
        toState: 'attached',
        metadata: { orderId: proof.orderId, facilityProfileId, contentType, byteSize: body.byteLength },
      });
    });
  } catch (error) {
    // Nothing references the object: remove it (best effort — an orphan is
    // unreachable through the API either way).
    await storage.deleteObject(objectKey).catch(() => undefined);
    throw error;
  }

  return { proofId: proof.id, orderId: proof.orderId, contentType, byteSize: body.byteLength };
}

/** True when `user` may read this proof's file. A patient may name an active
 * dependent (issue #305) — resolved through patientsService, never trusted. */
async function canReadProof(
  user: { id: string; role: Role },
  proof: { facilityProfileId: string; order: { patientProfileId: string } },
  patientProfileId?: string,
): Promise<{ allowed: boolean; viaGuardian: boolean }> {
  if (user.role === 'admin') return { allowed: true, viaGuardian: false };
  if (user.role === 'patient') {
    const patient = patientProfileId
      ? await patientsService.resolveActingProfile(user.id, patientProfileId)
      : await patientsService.getMyPatientProfile(user.id).catch(() => null);
    return {
      allowed: patient !== null && patient.id === proof.order.patientProfileId,
      viaGuardian: patient !== null && patient.userId === null,
    };
  }
  if (user.role === 'facility') {
    const facilityId = await facilitiesService.getOwnFacilityProfileId(user.id).catch(() => null);
    return { allowed: facilityId !== null && facilityId === proof.facilityProfileId, viaGuardian: false };
  }
  return { allowed: false, viaGuardian: false };
}

/** `GET /fulfillment-proofs/:proofId/attachment` — access-checked download. */
export async function openProofFile(
  user: { id: string; role: Role },
  proofId: string,
  route: string,
  patientProfileId?: string,
): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const proof = await repo.findFulfillmentProofWithOrder(proofId);
  const access = proof ? await canReadProof(user, proof, patientProfileId) : { allowed: false, viaGuardian: false };
  if (!proof || !access.allowed) throw new HttpError('PROOF_NOT_FOUND', NOT_FOUND);
  if (!proof.attachmentObjectKey || !proof.attachmentContentType) {
    // Includes legacy rows: their client-supplied URL is never served.
    throw new HttpError('PROOF_FILE_NOT_FOUND', 'No file has been attached to this proof.');
  }

  const stored = await getObjectStorage().getObject(proof.attachmentObjectKey);
  // The row exists, so the object must: a miss is an integrity failure.
  if (!stored) throw new Error(`Fulfillment proof ${proof.id} has no object in storage.`);

  auditService.recordAccess({
    accessedBy: user.id,
    patientProfileId: proof.order.patientProfileId,
    entityType: 'FulfillmentProof',
    entityId: proof.id,
    route,
    detail: access.viaGuardian ? 'fulfillment proof download (guardian)' : 'fulfillment proof download',
  });

  const extension = PROOF_FILE_SIGNATURES[proof.attachmentContentType]?.extension ?? 'bin';
  return { body: stored.body, contentType: proof.attachmentContentType, filename: `fulfillment-proof-${proof.id}.${extension}` };
}
