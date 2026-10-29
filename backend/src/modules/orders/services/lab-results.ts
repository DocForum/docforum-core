// Lab result attachment (Phase 5, issue #16 — docs/adr/0014).
//
// A facility attaches the result file for a lab order assigned to it; the
// file goes to object storage and a `LabResult` row records its opaque key.
// The `LabOrder` itself is never updated (hard rule 1), and neither is its
// status or FulfillmentRecord (hard rule 5 — the `fulfilled` transition is
// issue #15's facility-confirmed path, not this one).
//
// Reading the file back is restricted the way consultation notes are (PRD §7):
// the patient, the ordering doctor, and the fulfilling facility for this
// specific order. Anyone else gets the same 404 as a missing order, so ids
// can't be probed.
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { getObjectStorage } from '../../../utils/object-storage';
import * as auditService from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as facilitiesService from '../../facilities/services';
import * as patientsService from '../../patients/services';
import * as ordersRepo from '../repositories';

/** Accepted result formats and the leading bytes each must start with. The
 * declared Content-Type alone is not trusted: the body has to match it. */
const RESULT_FILE_SIGNATURES: Record<string, { extension: string; magic: number[] }> = {
  'application/pdf': { extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  'image/png': { extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/jpeg': { extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
};

export const LAB_RESULT_CONTENT_TYPES = Object.keys(RESULT_FILE_SIGNATURES);

const NOT_FOUND = 'Lab order not found.';

function normaliseContentType(raw: string | undefined): string {
  return (raw ?? '').split(';')[0]!.trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}

export interface LabResultView {
  id: string;
  labOrderId: string;
  fulfillingFacilityId: string;
  contentType: string | null;
  byteSize: number | null;
  createdAt: Date;
}

export async function attachLabResult(
  actor: auditService.AuditActor,
  labOrderId: string,
  file: { body: unknown; contentType: string | undefined },
): Promise<LabResultView> {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const facilityProfileId = await facilitiesService.getOwnFacilityProfileId(actor.userId);

  const order = await ordersRepo.findLabOrderWithResult(labOrderId);
  // Only the facility the order was issued to may attach — any other
  // facility sees the order as nonexistent.
  if (!order || order.facilityProfileId !== facilityProfileId) throw new HttpError(404, NOT_FOUND);
  if (order.correctedBy) {
    throw new HttpError(409, 'This lab order was superseded by a correction; attach the result to the correction.', 'LAB_ORDER_SUPERSEDED');
  }
  if (order.result) {
    throw new HttpError(409, 'A result has already been attached to this lab order.', 'LAB_RESULT_ALREADY_ATTACHED');
  }

  const contentType = normaliseContentType(file.contentType);
  const signature = RESULT_FILE_SIGNATURES[contentType];
  if (!signature) {
    throw new HttpError(415, `Result files must be one of: ${LAB_RESULT_CONTENT_TYPES.join(', ')}.`, 'LAB_RESULT_UNSUPPORTED_TYPE');
  }
  if (!Buffer.isBuffer(file.body) || file.body.length === 0) {
    throw new HttpError(400, 'The request body must be the result file.', 'LAB_RESULT_EMPTY');
  }
  const body = file.body;
  if (!signature.magic.every((byte, index) => body[index] === byte)) {
    throw new HttpError(415, `The file content is not a valid ${contentType} file.`, 'LAB_RESULT_CONTENT_MISMATCH');
  }

  // Opaque key: nothing about the patient, order or original filename.
  const objectKey = `lab-results/${randomUUID()}`;
  const storage = getObjectStorage();
  await storage.putObject({ key: objectKey, body, contentType });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const created = await ordersRepo.createLabResult(tx, {
        labOrderId: order.id, fulfillingFacilityId: facilityProfileId,
        resultObjectKey: objectKey, resultContentType: contentType, resultByteSize: body.length,
      });
      await auditService.record(tx, actor, {
        entityType: 'LabResult', entityId: created.id, action: 'lab_result.attached',
        fromState: null, toState: 'attached',
        metadata: { labOrderId: order.id, facilityProfileId, contentType, byteSize: body.length },
      });
      return created;
    });
    return {
      id: result.id, labOrderId: result.labOrderId, fulfillingFacilityId: result.fulfillingFacilityId,
      contentType: result.resultContentType, byteSize: result.resultByteSize, createdAt: result.createdAt,
    };
  } catch (error) {
    // The row didn't commit, so nothing references the object: remove it
    // (best effort — an orphan is unreachable through the API either way).
    await storage.deleteObject(objectKey).catch(() => undefined);
    if (isUniqueViolation(error)) {
      throw new HttpError(409, 'A result has already been attached to this lab order.', 'LAB_RESULT_ALREADY_ATTACHED');
    }
    throw error;
  }
}

/** True when `userId` is one of the parties PRD §7 allows to see this
 * order's result. Each role resolves only its own profile. */
async function canReadResult(
  user: { id: string; role: Role },
  order: { patientProfileId: string; orderingDoctorId: string; facilityProfileId: string },
  fulfillingFacilityId: string | undefined,
): Promise<boolean> {
  if (user.role === 'patient') {
    const patient = await patientsService.getMyPatientProfile(user.id).catch(() => null);
    return patient !== null && patient.id === order.patientProfileId;
  }
  if (user.role === 'doctor') {
    const doctor = await doctorsService.getMyDoctorProfile(user.id).catch(() => null);
    return doctor !== null && doctor.id === order.orderingDoctorId;
  }
  if (user.role === 'facility') {
    const facilityId = await facilitiesService.getOwnFacilityProfileId(user.id).catch(() => null);
    return facilityId !== null && facilityId === order.facilityProfileId
      && (fulfillingFacilityId === undefined || facilityId === fulfillingFacilityId);
  }
  return false;
}

export async function openLabResultFile(
  user: { id: string; role: Role },
  labOrderId: string,
  route: string,
): Promise<{ body: Buffer; contentType: string; filename: string }> {
  const order = await ordersRepo.findLabOrderWithResult(labOrderId);
  if (!order || !(await canReadResult(user, order, order.result?.fulfillingFacilityId))) {
    throw new HttpError(404, NOT_FOUND);
  }
  const result = order.result;
  if (!result?.resultObjectKey || !result.resultContentType) {
    throw new HttpError(404, 'No result file has been attached to this lab order.', 'LAB_RESULT_NOT_FOUND');
  }

  const stored = await getObjectStorage().getObject(result.resultObjectKey);
  // The row exists, so the object must: a miss is an integrity failure, not
  // a client error.
  if (!stored) throw new Error(`Lab result ${result.id} has no object in storage.`);

  auditService.recordAccess({
    accessedBy: user.id,
    patientProfileId: order.patientProfileId,
    entityType: 'LabResult',
    entityId: result.id,
    route,
    detail: 'lab result file download',
  });

  const extension = RESULT_FILE_SIGNATURES[result.resultContentType]?.extension ?? 'bin';
  return { body: stored.body, contentType: result.resultContentType, filename: `lab-result-${order.id}.${extension}` };
}
