---
file: docs/api/README.md
section: Auth (/auth) — backend/src/modules/auth
---
| `POST /auth/password` | patient, doctor, admin | Authenticated. Body `{ currentPassword, newPassword }`. Validates new password length (8–72 bytes) and rejects commonly breached passwords. Re-verifies current password with login throttle integration. Rejects unchanged passwords (`400 PASSWORD_UNCHANGED`). Bumps user `tokenVersion`, revokes other active `RefreshSession` records (`revokedReason: 'password_changed'`), updates caller session with new token version, and records `user.password_changed` AuditEvent. |
