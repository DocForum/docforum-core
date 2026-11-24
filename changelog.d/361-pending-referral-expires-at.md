Phase 3: patients and referring doctors can see when a pending referral expires
([issue #361](https://github.com/DocForum/docforum-core/issues/361)).
`GET /referrals/mine` and `GET /referrals/created` now return a derived
`expiresAt` (`updatedAt` + `REFERRAL_PENDING_TTL_DAYS`, `null` once a referral
is no longer pending). The deadline comes from one function that both the
response and the expiry sweep call, so the warning a patient sees cannot drift
from when the job actually expires the referral; unit tests assert the two agree
across the boundary ages. Derived field only — no `Referral` column, no
migration.
