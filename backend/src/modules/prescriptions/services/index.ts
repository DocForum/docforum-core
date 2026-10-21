// prescriptions services — other modules must only import from here,
// never from repositories/ directly. See AGENTS.md "Non-negotiable rules".
import * as prescriptionsRepo from '../repositories';

export interface PrescriptionItemInput {
  drugName: string;
  dosage: string;
  frequency: string;
  duration: string;
  medicationId?: string;
}

export interface PrescriptionView {
  id: string;
  consultationId: string;
  patientProfileId: string;
  prescribingDoctorId: string;
  facilityProfileId: string;
  amountStroops: bigint;
  status: string;
  supersedesPrescriptionId: string | null;
  createdAt: Date;
  items: Array<{
    id: string;
    drugName: string;
    dosage: string;
    frequency: string;
    duration: string;
    medicationId: string | null;
    medicationName: string | null;
    medicationStrength: string | null;
    medicationForm: string | null;
    medicationRoute: string | null;
    medication?: {
      id: string;
      genericName: string;
      strength: string | null;
      form: string | null;
      route: string | null;
    } | null;
  }>;
  paymentIntent?: {
    id: string;
    status: string;
    amountStroops: bigint;
  } | null;
}

export async function issuePrescription(_actor: { userId: string | null; role: string | null }, _input: {
  consultationId: string; facilityProfileId: string; amountStroops?: bigint; catalogItemCode?: string;
  supersedesPrescriptionId?: string;
  items: PrescriptionItemInput[];
}) {
  // This is a placeholder - the actual implementation is in orders/services
  // This module's service is for prescription-specific operations
  throw new Error('Use orders/services for prescription issuance');
}

export async function getPrescriptionById(id: string): Promise<PrescriptionView | null> {
  const prescription = await prescriptionsRepo.findPrescriptionById(id);
  if (!prescription) return null;

  return {
    id: prescription.id,
    consultationId: prescription.consultationId,
    patientProfileId: prescription.patientProfileId,
    prescribingDoctorId: prescription.prescribingDoctorId,
    facilityProfileId: prescription.facilityProfileId,
    amountStroops: prescription.amountStroops,
    status: prescription.status,
    supersedesPrescriptionId: prescription.supersedesPrescriptionId,
    createdAt: prescription.createdAt,
    items: prescription.items.map((item) => ({
      id: item.id,
      drugName: item.drugName,
      dosage: item.dosage,
      frequency: item.frequency,
      duration: item.duration,
      medicationId: item.medicationId,
      medicationName: item.medicationName,
      medicationStrength: item.medicationStrength ?? null,
      medicationForm: item.medicationForm ?? null,
      medicationRoute: item.medicationRoute ?? null,
      medication: item.medication ? {
        id: item.medication.id,
        genericName: item.medication.genericName,
        strength: item.medication.strength,
        form: item.medication.form,
        route: item.medication.route,
      } : null,
    })),
    paymentIntent: null, // Would be loaded separately if needed
  };
}

export async function getPrescriptionsByPatient(patientProfileId: string): Promise<PrescriptionView[]> {
  const prescriptions = await prescriptionsRepo.findPrescriptionsByPatient(patientProfileId);
  return prescriptions.map((prescription) => ({
    id: prescription.id,
    consultationId: prescription.consultationId,
    patientProfileId: prescription.patientProfileId,
    prescribingDoctorId: prescription.prescribingDoctorId,
    facilityProfileId: prescription.facilityProfileId,
    amountStroops: prescription.amountStroops,
    status: prescription.status,
    supersedesPrescriptionId: prescription.supersedesPrescriptionId,
    createdAt: prescription.createdAt,
    items: prescription.items.map((item) => ({
      id: item.id,
      drugName: item.drugName,
      dosage: item.dosage,
      frequency: item.frequency,
      duration: item.duration,
      medicationId: item.medicationId,
      medicationName: item.medicationName,
      medicationStrength: item.medicationStrength ?? null,
      medicationForm: item.medicationForm ?? null,
      medicationRoute: item.medicationRoute ?? null,
      medication: item.medication ? {
        id: item.medication.id,
        genericName: item.medication.genericName,
        strength: item.medication.strength,
        form: item.medication.form,
        route: item.medication.route,
      } : null,
    })),
    paymentIntent: null,
  }));
}