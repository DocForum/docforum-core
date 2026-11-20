Phase 2: partial unique index for active waitlist entries and typed status enum
([issue #295](https://github.com/DocForum/docforum-core/issues/295)).
Replaced `WaitlistEntry` table-wide unique constraint with a partial unique index
covering active entries (`pending`, `on_hold`) using PostgreSQL `NULLS NOT DISTINCT`
for null-safe doctor/specialty deduplication. Converted `status` to `WaitlistStatus` enum.
Patients can now re-join waitlists after leaving or acceptance, and concurrent duplicate
joins are prevented at the database level.
