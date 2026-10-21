Phase 2 (issue #4): an appointment's consultation can be closed exactly
once. `Consultation` is one-to-one with its `Appointment`
(`Consultation.appointmentId` UNIQUE, `docs/adr/0009`), so "closed once" is
a database constraint (`P2002` → `409`) rather than an app-level
read-then-write check. All three writers — `POST /consultations`,
`POST /appointments/:appointmentId/consultation`, and the orders flow's
consultation step — now go through one service
(`consultationsService.createConsultation`), so note encryption
(AES-256-GCM, issue #46), the own-`completed`-appointment rule and the
single `consultation.closed` audit event apply to every address.
`outcome` stays nullable in the schema (a record can exist before
sign-off); the close route requires it at the boundary. Integration test:
`backend/tests/integration/consultation.test.mts`.
