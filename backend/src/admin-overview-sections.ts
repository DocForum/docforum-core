// Composition root for the admin overview (Phase 8, issue #123). Each module
// owns its section in its services/; this file is the explicit list of what
// the overview shows, so adding a queue is one line here. Lives outside
// modules/ because it is wiring, not business logic.
//
// Not yet contributed: payments stuck in intermediate states, failed jobs,
// referrals pending too long, orders not routed to a facility. Each needs a
// count-and-age service in its own module before it can be listed here.
import { doctorVerificationQueueCounts } from './modules/doctors/services';
import {
  createOverviewCache,
  runOverviewSections,
  type AdminOverview,
  type AdminOverviewSectionDefinition,
} from './utils/admin-overview';

const SECTIONS: AdminOverviewSectionDefinition[] = [
  {
    key: 'doctor-verification',
    label: 'Doctors awaiting verification',
    drillDownPath: '/doctors?verificationStatus=pending',
    run: doctorVerificationQueueCounts,
  },
];

export const getAdminOverview = createOverviewCache(() => runOverviewSections(SECTIONS));

export type { AdminOverview };
