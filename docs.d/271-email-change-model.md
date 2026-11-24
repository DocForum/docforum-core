---
file: ARCHITECTURE.md
section: 4. Data models > 4.9 Auth hardening state (Phase 8)
---
Email change token (issue #271):
```
EmailChangeToken
  id, user_id (FK User.id ON DELETE CASCADE), new_email, token_hash (unique),
  expires_at, consumed_at, created_at
  # Stored hashed, never raw. Single-use, expiring. Bound to pending new_email.
```
