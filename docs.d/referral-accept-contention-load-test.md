## ARCHITECTURE.md §4 / docs/api/README.md

No models or endpoints changed. Load-test tooling only:
- `backend/tests/load/referral-accept-contention.js` — k6 scenario for `POST /api/referrals/:id/accept`.
- `backend/tests/load/seed-referral-accept-contention.ts` — seeds one doctor, open slots and pending referrals (refuses Render hosts).
- `backend/tests/load/verify-referral-accept-contention.ts` — post-run DB invariant checks.
