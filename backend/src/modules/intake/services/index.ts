import { HttpError } from '../../../http-error';
import * as patientsService from '../../patients/services';
import * as auditService from '../../audit/services';
import { paginate, type PatientExportSection } from '../../patients/services';
import * as intakeRepo from '../repositories';
import { decryptField, encryptField } from '../../../utils/field-encryption';
import type { z } from 'zod';
import type { createIntakeSchema } from '../validation';

type CreateIntakeInput = z.infer<typeof createIntakeSchema>;

export async function createMyIntake(actor: auditService.AuditActor, input: CreateIntakeInput) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patient = await patientsService.getMyPatientProfile(actor.userId);
  // Clinical free text is encrypted at rest (ARCHITECTURE.md §2, field-level encryption).
  const record = await intakeRepo.createIntake(patient.id, input.symptoms, encryptField(input.freeTextNotes) ?? undefined);
  return { ...record, freeTextNotes: decryptField(record.freeTextNotes) ?? null };
}

export async function listMyIntakes(userId: string) {
  const patient = await patientsService.getMyPatientProfile(userId);
  const records = await intakeRepo.findIntakesForPatient(patient.id);
  for (const record of records) {
    auditService.recordAccess({
      accessedBy: userId,
      patientProfileId: patient.id,
      entityType: 'IntakeForm',
      entityId: record.id,
      route: 'GET /intake/mine',
    });
  }
  return records.map((record) => ({ ...record, freeTextNotes: decryptField(record.freeTextNotes) ?? null }));
}

export const intakeExportSection: PatientExportSection = {
  name: 'intake',
  version: 1,
  pages(subject, pageSize) {
    return paginate(
      pageSize,
      (cursor, take) => intakeRepo.findIntakesPageForPatient(subject.patientProfileId, cursor, take),
      (rows) => rows.map((row) => ({
        id: row.id,
        symptoms: row.symptoms,
        freeTextNotes: decryptField(row.freeTextNotes) ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  },
};
