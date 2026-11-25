feat(referrals): Filter the admin referral queue by specialty and target doctor

- Added `targetSpecialtyId` and `targetDoctorId` query filters to
  `adminQueueQuerySchema` and the repository `listAdminQueue` query.
- Referrals with `null targetSpecialtyId` (named-doctor referrals) do not
  match a specialty filter, preserving the distinction between specialty-only
  and doctor-named referrals.
- The admin queue endpoint `GET /referrals/admin/queue` now accepts these
  additional optional query parameters, conjunctive with the existing
  `status`, `olderThan`, and `loopFlagged` filters.
- Updated `docs/api/README.md` row for `GET /referrals/admin/queue` to
  document the new filters.
- Integration tests added in `backend/tests/integration/admin-referrals.test.mts`.

Closes #339