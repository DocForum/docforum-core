## ARCHITECTURE.md §4 / docs/api/README.md

No models or endpoints changed. Load-test tooling only:
- `backend/tests/load/referral-accept-contention.js` — k6 scenario for `POST /api/referrals/:id/accept`.
- `backend/tests/load/seed-referral-accept-contention.ts` — seeds one doctor, open slots and pending referrals (refuses Render hosts).
- `backend/tests/load/verify-referral-accept-contention.ts` — post-run DB invariant checks.

Note: the factory fix in `backend/tests/factories/index.ts` (CI typecheck failure) removes the non-existent `doctorProfileId` field from the `Referral` create input; the doctor is linked via the schema's actual relation field, so no new schema fields are introduced and §4 is unchanged.
