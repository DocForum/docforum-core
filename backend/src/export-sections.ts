// Composition root for the patient data export registry (Phase 8, issue
// #40). Each module owns and exports its own section from its services/;
// this file is the one explicit list of what an export contains, so a
// section can't silently go missing because its module happened not to be
// imported. Lives outside modules/ on purpose: it's wiring, not business
// logic, and keeps the patients module from importing every module that
// itself imports patients.
//
// New module with patient data? Export a PatientExportSection from its
// services/ and add it here. See ARCHITECTURE.md §3.
import { accountExportSection } from './modules/auth/services';
import { appointmentsExportSection } from './modules/appointments/services';
import { paymentsExportSection } from './modules/payments/services';
import { profileExportSection, registerExportSection } from './modules/patients/services';
import { prescriptionsExportSection, labOrdersExportSection } from './modules/orders/services';

export const PATIENT_EXPORT_SECTIONS = [
  accountExportSection,
  profileExportSection,
  appointmentsExportSection,
  paymentsExportSection,
  prescriptionsExportSection,
  labOrdersExportSection,
];

export function registerPatientExportSections(): void {
  for (const section of PATIENT_EXPORT_SECTIONS) registerExportSection(section);
}
