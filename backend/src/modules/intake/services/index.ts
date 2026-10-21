import { HttpError } from '../../../http-error';
import * as patientsService from '../../patients/services';
import * as auditService from '../../audit/services';
import { paginate, type PatientExportSection } from '../../patients/services';
import * as intakeRepo from '../repositories';
import type { z } from 'zod';
import type { createIntakeSchema } from '../validation';

type CreateIntakeInput = z.infer<typeof createIntakeSchema>;

export async function createMyIntake(actor: auditService.AuditActor, input: CreateIntakeInput) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patient = await patientsService.getMyPatientProfile(actor.userId);
  return intakeRepo.createIntake(patient.id, input.symptoms, input.freeTextNotes);
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
  return records;
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
        freeTextNotes: row.freeTextNotes,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  },
};
