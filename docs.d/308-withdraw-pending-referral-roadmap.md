---
file: ROADMAP.md
section: Phase 3 — Referrals
---
- [x] Referring doctor can withdraw their own pending referral (issue #308): `POST /referrals/:referralId/withdraw` requires a bounded reason and performs one conditional `pending → cancelled` update (guarding `resultingAppointmentId IS NULL`) plus a `referral.withdraw` AuditEvent in the same transaction. The existing `cancelled` status and `cancelledReason` column are reused, so no schema change; withdraw/accept race and authorisation are covered by integration tests. Closes [issue #308](https://github.com/DocForum/docforum-core/issues/308).
