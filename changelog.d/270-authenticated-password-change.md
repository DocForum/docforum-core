Phase 8: authenticated password change endpoint ([issue #270](https://github.com/DocForum/docforum-core/issues/270)).
Add `POST /auth/password` endpoint requiring current password re-verification, enforcing new password length and breached denylist, rejecting unchanged passwords, revoking other sessions, bumping token version, preserving caller session, and emitting audit event.
