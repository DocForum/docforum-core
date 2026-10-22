Phase 3: referral expiry job
([issue #8](https://github.com/DocForum/docforum-core/issues/8)). One interval
sweep (`src/jobs/referral-expiry.ts`, started from `server.ts` like the other
jobs — no queue) moves `pending` referrals untouched for
`REFERRAL_PENDING_TTL_DAYS` (default 14; sweep every
`REFERRAL_EXPIRY_SWEEP_INTERVAL_SECONDS`, default 3600) to the terminal
`expired` state through one conditional UPDATE in the referrals module, so it
is safe across processes and re-runs, and a concurrent patient accept/decline
either wins or finds the referral expired — never both. The age clock is
`updatedAt`, so a referral the cascade (#67) or an admin (#68) returned to
`pending` gets a fresh window. `accepted` referrals are never swept.

Schema: new `Referral.expiredAt` and `Referral.expiredReason`
(`ttl` | `no_show`), migration `20261022090000_referral_expiry`, which also
backfills existing `expired` rows as `no_show` (the only way to expire until
now) and adds a `(status, updatedAt)` index. `expired` stays distinct from
`declined` and `cancelled`; `expiredReason` tells the two ways into `expired`
apart, and the no-show cascade now records `no_show`. The TTL sweep also sets
`referringDoctorNotifiedAt`, the existing seam Phase 6 reads.

Not built: flagging the *patient* — there is no notification layer until
Phase 6. When it lands, it can select `status = 'expired' AND expiredReason =
'ttl'`; no marker for "patient notified" exists yet.
