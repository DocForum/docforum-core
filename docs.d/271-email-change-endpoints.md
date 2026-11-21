---
file: docs/api/README.md
section: Auth (/auth) — backend/src/modules/auth
---
| `POST /auth/change-email/request` | patient, doctor, admin | Authenticated. Body `{ newEmail, password }`. Requires current password confirmation with brute-force protection. Generates expiring `EmailChangeToken`, sends confirmation link to new email and alert notice to current email. Emits `email_change.requested` AuditEvent. |
| `POST /auth/change-email/confirm` | public | Body `{ token }`. Atomically changes account email and sets `emailVerifiedAt` if token is valid and unconsumed, and new address is not taken. Emits `email_change.confirmed` AuditEvent. |
