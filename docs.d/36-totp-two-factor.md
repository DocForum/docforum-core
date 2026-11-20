---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] TOTP two-factor authentication (RFC 6238) with single-use recovery
  codes. Enrolment returns a provisioning URI and confirms with one valid
  code; login becomes two-step (`mfaRequired` + a short-lived `mfa_pending`
  token that no other route accepts). Replay is blocked by claiming the
  TOTP time step with one conditional `updateMany`, not by a client flag.
  Secrets are encrypted with the existing field-encryption key; recovery
  codes are SHA-256 hashed and single-use. `TOTP_REQUIRE_FOR_ADMIN` can
  force enrolment for admin accounts through a narrow `mfa_enrollment`
  token that only the setup/enable routes accept. Implemented without a new
  dependency (`node:crypto`). Tracked as
  [issue #36](https://github.com/DocForum/docforum-core/issues/36)
  (High, 200 pts) — **Done**. Tests:
  `backend/tests/unit/totp.test.ts` (RFC 4226/6238 vectors) and
  `backend/tests/integration/two-factor.test.mts`.
