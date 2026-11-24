Phase 3: the referring doctor can withdraw their own pending referral
([issue #308](https://github.com/DocForum/docforum-core/issues/308)).
`POST /referrals/:referralId/withdraw` takes a required 1–200 character reason,
uses the same conditional `pending → cancelled` update as accept/decline (also
guarding `resultingAppointmentId IS NULL`) and writes a `referral.withdraw`
AuditEvent in the same transaction. Reuses the existing `cancelled` status and
`cancelledReason` column; no schema change. Integration tests cover the
withdraw/accept race, another doctor's referral (404), accepted referrals (409)
and validation.
