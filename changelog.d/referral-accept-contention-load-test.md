### Added
- Load test for referral accept contention (`backend/tests/load/referral-accept-contention.js`) with database-level assertions for double booking and referral/appointment consistency.

### Fixed
- Test factory for referrals no longer passes the unknown `doctorProfileId` field to the Prisma create input, which broke the backend typecheck in CI (`backend/tests/factories/index.ts`).
