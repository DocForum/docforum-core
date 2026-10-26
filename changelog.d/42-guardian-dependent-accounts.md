Issue #42 (guardian and dependent accounts) opened as a PR
with ADR 0011: dependents are guardian-owned patient profiles
(`PatientProfile.userId` now nullable, a CHECK requires a DOB when it's
null) linked by a new `Guardianship` table (real FKs, unique per pair,
`revokedAt`, never deleted). The bare `guardianUserId` string is dropped;
the migration aborts if any row still holds a value instead of silently
discarding it (tested both ways). `POST`/`GET /patients/me/dependents` are
create-only; `POST /appointments` takes `patientProfileId`, authorised by
`patientsService.resolveActingProfile` before the booking transaction,
which is otherwise byte-for-byte unchanged — re-proven with a concurrent
race that includes a guardian booking. Guardian access ends at the age of
majority (default 18). PRD §8.2.5 marked resolved/re-scoped.

Reconciled with #41 (account deletion), which merged first:
`PatientProfile.userId` is nullable but keeps #41's `ON DELETE RESTRICT`;
deleting a guardian's account revokes their guardianships in the same
transaction (dependents and their records untouched), a deleted account
acts for no one through `resolveActingProfile`, and the account purge holds
a guardian's tombstone while guardianship rows name it (hold
`guardianships`). ADR 0010's retention table and ADR 0011 updated.
