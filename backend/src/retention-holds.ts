// Composition root for account-deletion retention holds (Phase 8, issue
// #41, docs/adr/0010). Each module that keeps records about a patient which
// must survive account deletion answers "does this patient have any?"
// through its own service; the patients module's purge never removes a
// profile any hold says yes for. Lives outside modules/ because it's
// wiring: the patients module can't import modules that already import it.
//
// New module with patient-linked records (intake, consultations, referrals,
// prescriptions, lab orders)? Reference PatientProfile with
// `onDelete: Restrict` AND add a hold here. The FK is the backstop; the hold
// is what keeps the purge from even trying.
import { hasAppointmentsForPatient } from './modules/appointments/services';
import { hasAccessLogsForPatient } from './modules/audit/services';
import { hasOrdersForPatient } from './modules/orders/services';
import { hasPaymentIntentsForPatient } from './modules/payments/services';
import { hasReferralsForPatient } from './modules/referrals/services';
import { registerRetentionHold, type RetentionHold } from './modules/patients/services';

export const RETENTION_HOLDS: RetentionHold[] = [
  { name: 'appointments', holds: hasAppointmentsForPatient },
  { name: 'payments', holds: hasPaymentIntentsForPatient },
  { name: 'orders', holds: hasOrdersForPatient },
  { name: 'referrals', holds: hasReferralsForPatient },
  { name: 'access_logs', holds: hasAccessLogsForPatient },
];

export function registerRetentionHolds(): void {
  for (const hold of RETENTION_HOLDS) registerRetentionHold(hold);
}
