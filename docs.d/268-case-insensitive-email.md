---
file: docs/api/README.md
section: Auth (/auth) — backend/src/modules/auth
---
### Case-insensitive email normalisation (Phase 8, issue #268)

Email addresses are trimmed and canonicalised to lowercase across all authentication and registration entry points (`/auth/signup`, `/auth/login`, `/auth/signup-with-invite`, `/auth/password-reset/request`, `/auth/password-reset/confirm`, `/auth/change-email/request`). A PostgreSQL functional unique index on `LOWER("email")` guarantees case-insensitive uniqueness at the database level.
