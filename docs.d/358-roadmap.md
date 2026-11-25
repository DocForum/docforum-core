---
file: ROADMAP.md
section: Phase 2 — Intake, appointments, consultations
---
- [x] Integration tests for the doctor's day view and the appointment status machine (issue #358): `GET /appointments/doctor/today` returns only the caller's own scheduled appointments that hold a slot, ordered by slot start, with the day taken from `DoctorProfile.timeZone` rather than the server or UTC; every legal transition out of `scheduled`, each illegal one (terminal status, too early, an unassignable status), an unknown id at 404 and another doctor at 403, and concurrent double transitions where exactly one request wins and the slot is freed once. `vi.useFakeTimers({ toFake: ['Date'] })` pins the clock so the suite does not depend on when CI runs. `backend/tests/integration/doctor-day-view-and-status-transitions.test.mts`.
