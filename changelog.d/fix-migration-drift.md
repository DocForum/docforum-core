Fixed drift between the committed migrations and the schema: migration
`20261119090000_fix_schema_drift` converts `DoctorSpecialty.verificationStatus`
from `VARCHAR(191)` to the `VerificationStatus` enum (and `reviewer` /
`rejectionReason` to `TEXT`), and gives `RateLimitRecord` the
`(key, scope, consumedAt)` index and no `updatedAt` default, as the schema
declares. The schema now declares the existing trigram search indexes and the
truncated `FacilityPrice` index names, so Prisma no longer wants to drop or
rename them. `scripts/check-migration-drift.mjs` now exits non-zero on drift
(it used to print FAILED and exit 0), and CI runs it on every PR.
