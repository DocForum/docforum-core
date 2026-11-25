feat(ci): Run the migration drift check in CI

- Added `prisma validate` and `prisma format --check` steps next to the
  existing drift check in `.github/workflows/ci.yml`.
- The drift check (`node scripts/check-migration-drift.mjs`) now runs in
  parallel with tests to keep job time reasonable.
- Documented the schema checks in `CONTRIBUTING.md` under the "Schema"
  section, describing `prisma validate`, `prisma format --check`, and the
  drift check.
- Script header updated to reference issue #376 and the CI check.
- Fails on a deliberate drift in a test branch (verified via commit
  ad989bc).
- `prisma validate` and `prisma format --check` run in CI on every PR.

Closes #342