Phase 2 (issue #64): consultation notes are now signed off rather than edited
in place. `Consultation.signedAt` stays null while the authoring doctor can
still change the note; `POST /consultations/:id/sign-off` sets it once, after
which a database trigger refuses any change to `notes`, `outcome` or
`signedAt` (a direct Prisma UPDATE fails too). Corrections after sign-off are
append-only `ConsultationAddendum` rows added with
`POST /consultations/:id/addenda` (encrypted, authoring-doctor only), and
`GET /consultations/:id` returns the note plus addenda oldest-first.
Unsigned notes auto-sign `CONSULTATION_AUTO_SIGN_OFF_HOURS` (default 24) after
`Appointment.completedAt`. Referrals may still be created before sign-off —
`snapshotNotes` is already an immutable copy at creation. The migration
backfills existing consultations as signed and adds an RLS UPDATE policy for
the treating doctor. Docs: ARCHITECTURE.md §4.2/§4.3,
ARCHITECTURE_ESSENTIALS.md hard rule 8, `docs/api/README.md`.
