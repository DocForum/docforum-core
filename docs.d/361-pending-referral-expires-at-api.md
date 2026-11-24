---
file: docs/api/README.md
after: "| `GET /referrals/admin/:referralId/audit-events` |"
---
`GET /referrals/mine` and `GET /referrals/created` add a derived **`expiresAt`**
to each row (issue #361): the ISO timestamp a `pending` referral is due to
expire, i.e. `updatedAt` plus `REFERRAL_PENDING_TTL_DAYS`. It is computed in
`backend/src/modules/referrals/services/index.ts` from the same function the
expiry sweep uses, so a referral listed as expiring at T is one the sweep moves
to `expired` at T; `GET /referrals/incoming` is unchanged. Because the TTL is
read per call, a referral returned to `pending` (the cascade, issue #67, or an
admin reassignment, issue #68) gets a fresh deadline with no extra write, and
changing `REFERRAL_PENDING_TTL_DAYS` moves the reported deadline and the sweep
together. **`null` on every non-pending row** — `accepted` referrals are never
swept, and a terminal referral has no deadline left to warn about. No column is
added to `Referral` (ARCHITECTURE.md §4 is unchanged): `expiredAt` and
`expiredReason` stay the sweep's record of what happened, while `expiresAt` is a
response field describing a future that may not arrive.
