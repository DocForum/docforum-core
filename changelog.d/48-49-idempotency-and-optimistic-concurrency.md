Consolidate idempotency-Key support (issue #48) and optimistic concurrency with
version fields and `If-Match` (issue #49) into one PR. Adds the
`IdempotencyKey` model with a unique `(userId, key)` constraint and the shared
`optimistic-concurrency` middleware (`setVersionEtag`, `requireIfMatch`,
`expectedVersion`, `versionConflict`), plus `version Int @default(1)` on `User`,
`PatientProfile`, `DoctorProfile`, `FacilityProfile`, `FacilityCapability`,
`Appointment` and `PaymentIntent`. `PATCH /doctors/me` is the reference
implementation; system-driven updates (email verification, payment transitions)
also bump the version. Existing status-conflict `409` behavior is preserved.
