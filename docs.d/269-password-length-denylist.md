---
file: docs/api/README.md
section: Auth (/auth) — backend/src/modules/auth
---
### Password length and denylist enforcement (Phase 8, issue #269)

Passwords are enforced between 8 characters and 72 bytes across signup, password reset confirmation, and authenticated password changes. The 72-byte limit prevents bcrypt truncation and CPU denial-of-service, measured in UTF-8 bytes rather than code points. Commonly breached and easily guessable passwords are rejected against a static embedded denylist (`PASSWORD_COMMONLY_BREACHED`).
