Idempotency-Key support on referral accept, reschedule and waitlist accept (issue #310).

Mount `idempotency()` after authentication on `POST /referrals/:id/accept`, `POST /appointments/:id/reschedule` and `POST /appointments/waitlist/accept`, so retries of these mutations replay the stored response instead of re-executing them. Keys are scoped per user (`(userId, key)` unique index), so guardian/dependent acting is naturally isolated. Integration tests cover replay, 422 on body mismatch, and per-user scope isolation for all three routes.
