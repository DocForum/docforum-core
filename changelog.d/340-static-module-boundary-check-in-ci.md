feat(ci): Static module-boundary check in CI

- Added `scripts/check-module-boundaries.mjs` that statically checks for
  imports from other modules' `repositories`, `controllers`, or `routes`
  directories. A violation triggers a non-zero exit code.
- Existing violations are tracked in an allowlist so the check can be
  introduced incrementally without breaking the build.
- Configured the script to run in `.github/workflows/ci.yml` as part of the
  CI pipeline.
- Allowlist for existing violations has been added; new violations will
  cause CI to fail.
- Verified that a deliberately bad import in a test fixture makes the
  check fail.

Closes #340