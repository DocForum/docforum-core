// Every module's HTTP routes: one line per module, kept alphabetical. app.ts
// calls each `mount` in turn. A module mounts its own routers in its
// mount.ts, so adding routes or a router never touches app.ts.
//
// Order between modules doesn't matter: no two routers on a shared prefix
// define overlapping routes, and the routers that apply middleware to every
// request they see (users' and flags' `/admin` routers) only guard routes
// that are all admin-only.
export { mount as appointments } from './modules/appointments/mount';
export { mount as audit } from './modules/audit/mount';
export { mount as auth } from './modules/auth/mount';
export { mount as availability } from './modules/availability/mount';
export { mount as consultations } from './modules/consultations/mount';
export { mount as doctors } from './modules/doctors/mount';
export { mount as events } from './events/mount';
export { mount as facilities } from './modules/facilities/mount';
export { mount as flags } from './modules/flags/mount';
export { mount as intake } from './modules/intake/mount';
export { mount as labOrders } from './modules/lab-orders/mount';
export { mount as labTests } from './modules/lab-tests/mount';
export { mount as medications } from './modules/medications/mount';
export { mount as metrics } from './modules/metrics/mount';
export { mount as notifications } from './modules/notifications/mount';
export { mount as orders } from './modules/orders/mount';
export { mount as patients } from './modules/patients/mount';
export { mount as payments } from './modules/payments/mount';
export { mount as pharmacyOrders } from './modules/pharmacy-orders/mount';
export { mount as referrals } from './modules/referrals/mount';
export { mount as users } from './modules/users/mount';
