Phase 9: load test for referral accept contention
([issue #349](https://github.com/DocForum/docforum-core/issues/349)).
`backend/tests/load/referral-accept-contention.js` (k6) has one patient per
VU accept a pending referral into one specialist's few slots at the same
moment. `seed-referral-accept-contention.mts` seeds the specialist, the slots
and the patients' referrals (each from a real completed consultation) and
writes the k6 input; `verify-referral-accept-contention.mts` asserts from the
database afterwards that no slot is double-booked and every referral is either
accepted with exactly one appointment or still pending. Both refuse Render
hosts. The manual `.github/workflows/load-tests.yml` runs seed → server → k6 →
verify against a throwaway Postgres on the runner. The same seeding and
invariants run in CI as `tests/integration/referral-accept-contention.test.mts`
(port 5490). `tests/factories` gains a `referralFactory` with the real
required `Referral` fields. No schema or endpoint changes.
