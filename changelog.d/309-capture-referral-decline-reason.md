Phase 3: capture an optional reason when a patient declines a referral
(issue #309). Added `declineReason` (`cost` | `distance` | `second_opinion` |
`other`) and `declineReasonNote` (bounded `varchar(200)`, nullable) to the
`Referral` model — both null unless the patient supplies them.

`POST /referrals/:referralId/decline` now accepts an optional `reason: { enum,
note? }`. The body may still be omitted entirely (backwards compatible), send
the enum alone, or the enum plus a note of at most 200 characters; an invalid
enum or an over-long note is a `400` and changes nothing. The reason is stored
on the referral row, and the `referral.declined` AuditEvent records only the
enum as `metadata.declineReason`. The free-text note is patient-written and may
carry PHI, so it is never copied into audit metadata (ARCHITECTURE.md §4.10).

`GET /referrals/created` now returns `declineReason` and `declineReasonNote` on
each row so the referring doctor can see why the patient declined.

No change for callers that decline without a reason; the migration only adds a
new enum and two nullable columns, so existing rows are untouched.
