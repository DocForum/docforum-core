Phase 8: account deletion with clinical-record retention
([issue #41](https://github.com/DocForum/docforum-core/issues/41)), with ADR
0010's per-model retention table. `DELETE /patients/me` anonymises in place
rather than cascading: `User.deletedAt` + `PatientProfile.anonymizedAt`,
tombstoned email (frees the address for a new signup), unusable password,
cleared verification; appointments and payment intents are untouched and keep
their FK. The migration flips `PatientProfile.userId` from CASCADE to
RESTRICT (the only FK changed — inventory in the ADR). An interval purge
removes only tombstones no module holds records for. Found while testing:
Postgres reports RESTRICT as SQLSTATE 23001, which Prisma surfaces as an
unknown error rather than P2003 — recorded in ARCHITECTURE.md §6.1.6. The
legal retention period for clinical records is explicitly left open (an open
decision in the ADR), not invented.

Rebased onto `main` after #40 (patient export), #45 (access log) and the
Phase 3/4 referral and order models landed: the purge now also holds back for
prescriptions, lab orders, referrals and access-log rows (each through its
own module's service), and a patient's exports are deleted inside the
anonymisation transaction, as the ADR's wiring note required of whichever of
#40/#41 merged second. ADR renumbered 0007 → 0010 (0007 is now the backups
ADR).
