import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import * as moduleMounts from '../../src/mounts';
import { adminAuthRouter, authRouter } from '../../src/modules/auth/routes';
import {
  adminDoctorsRouter,
  doctorsRouter,
  specialtiesRouter,
  symptomsRouter,
} from '../../src/modules/doctors/routes';
import { availabilityRouter } from '../../src/modules/availability/routes';
import { appointmentsRouter } from '../../src/modules/appointments/routes';
import {
  appointmentConsultationsRouter,
  consultationsRouter,
  followUpsRouter,
} from '../../src/modules/consultations/routes';
import { ordersRouter } from '../../src/modules/orders/routes';
import { adminOrdersRouter } from '../../src/modules/orders/routes/admin';
import { labResultsRouter } from '../../src/modules/orders/routes/lab-results';
import { metricsRouter } from '../../src/modules/metrics/routes';
import { fulfillmentProofsRouter, pharmacyOrdersRouter } from '../../src/modules/pharmacy-orders/routes';
import { labOrdersRouter } from '../../src/modules/lab-orders/routes';
import { prescriptionsRouter } from '../../src/modules/prescriptions/routes';
import { labTestsRouter } from '../../src/modules/lab-tests/routes';
import { paymentsAdminRouter, paymentsRouter } from '../../src/modules/payments/routes';
import { escrowEventsRouter } from '../../src/modules/payments/routes/escrow-events';
import { facilitiesRouter } from '../../src/modules/facilities/routes';
import { patientsRouter } from '../../src/modules/patients/routes';
import { adminRouter } from '../../src/modules/users/routes';
import { adminAuditRouter, auditRouter, patientAuditRouter } from '../../src/modules/audit/routes';
import { referralsRouter } from '../../src/modules/referrals/routes';
import { outboxAdminRouter } from '../../src/events/routes';
import { notificationsRouter } from '../../src/modules/notifications/routes';
import { adminFlagsRouter, meFlagsRouter } from '../../src/modules/flags/routes';
import { intakeRouter } from '../../src/modules/intake/routes';
import { medicationsRouter } from '../../src/modules/medications/routes';

// Every (prefix, router) pair app.ts mounted before the module mounts
// existed. A mount that goes missing, moves to another prefix or appears
// twice fails here. Add a pair when a module mounts a new router.
const EXPECTED: Array<[string, unknown]> = [
  ['/auth', authRouter],
  ['/admin', adminAuthRouter],
  ['/admin', adminDoctorsRouter],
  ['/doctors', doctorsRouter],
  ['/specialties', specialtiesRouter],
  // Issue #60: public symptom vocabulary / autocomplete.
  ['/symptoms', symptomsRouter],
  ['/availability', availabilityRouter],
  ['/appointments', appointmentsRouter],
  ['/appointments', appointmentConsultationsRouter],
  ['/intake', intakeRouter],
  ['/orders', ordersRouter],
  ['/medications', medicationsRouter],
  ['/lab-results', labResultsRouter],
  ['/pharmacy-orders', pharmacyOrdersRouter],
  ['/fulfillment-proofs', fulfillmentProofsRouter],
  ['/lab-orders', labOrdersRouter],
  // Issue #314: prescription detail read.
  ['/prescriptions', prescriptionsRouter],
  ['/lab-tests', labTestsRouter],
  ['/admin', adminOrdersRouter],
  ['/admin', metricsRouter],
  ['/payments', paymentsRouter],
  ['/facilities', facilitiesRouter],
  ['/patients', patientsRouter],
  ['/admin', adminRouter],
  ['/admin/outbox', outboxAdminRouter],
  ['/admin', auditRouter],
  ['/admin/payments', escrowEventsRouter],
  ['/admin/payments', paymentsAdminRouter],
  ['/admin', adminAuditRouter],
  ['/patients', patientAuditRouter],
  ['/referrals', referralsRouter],
  ['/notifications', notificationsRouter],
  ['/me', meFlagsRouter],
  ['/admin', adminFlagsRouter],
  ['/consultations', consultationsRouter],
  ['/follow-ups', followUpsRouter],
];

describe('module mounts (src/mounts.ts)', () => {
  it('mounts exactly the expected routers at the expected prefixes', () => {
    const mounted: Array<[string, unknown]> = [];
    const app = { use: (path: string, router: unknown) => mounted.push([path, router]) } as unknown as Express;
    for (const mount of Object.values(moduleMounts)) mount(app);

    const key = ([path, router]: [string, unknown]) => {
      const index = EXPECTED.findIndex(([, r]) => r === router);
      return `${path} ${index}`;
    };
    expect(mounted.map(key).sort()).toEqual(EXPECTED.map(key).sort());
    expect(mounted).toHaveLength(EXPECTED.length);
  });
});
