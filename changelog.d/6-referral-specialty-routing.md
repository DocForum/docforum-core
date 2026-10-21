Phase 3: specialty-only referral routing decided and implemented
([issue #6](https://github.com/DocForum/docforum-core/issues/6)).
[`docs/adr/0008-referral-routing-without-target-doctor.md`](docs/adr/0008-referral-routing-without-target-doctor.md)
closes the ARCHITECTURE.md §6.1.2 gap: a referral may name a doctor *or* a
specialty, and a specialty-only target is resolved **at creation** to the
least-loaded eligible doctor (verified, holds the specialty, not the
referring doctor, active account; fewest `pending`+`accepted` referrals,
ties by doctor id). `Referral.targetDoctorId` stays NOT NULL, so nothing
is ever created unassigned; zero eligible doctors is a `422
REFERRAL_NO_ELIGIBLE_TARGET` and writes no row. No schema or migration
change — the new surface is the optional `targetDoctorId` in the existing
referral create/batch bodies and the `targetDoctorId` the response now
carries for a routed referral.

Not built, deliberately: PRD §8.2.2's patient-facing "waiting for a
specialist" state — it requires a target-less referral, which the ADR
rejects. Issue #8's time-based expiry is still the answer for a routed
referral whose doctor never offers a slot.

Note for the next contributor: this change also restores the referrals
table in `docs/api/README.md`, which an earlier commit had truncated
mid-row (along with the payments/orders/audit sections after it — still
missing, and not restored here).
