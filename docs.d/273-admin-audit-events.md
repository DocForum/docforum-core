---
file: ARCHITECTURE.md
section: 4. Data models > 4.10 Audit trail (Phase 8, issue #43)
---
- `user.deactivated`: active → deactivated (admin deactivating user account, metadata: cleared sessions count).
- `user.reactivated`: deactivated → active (admin reactivating user account).
- `admin_invite.created`: null → null (admin creating admin invite, metadata: inviteId).
- `user.sessions_revoked`: null → null (admin revoking all sessions for a user, metadata: clearedCount).
- `login_throttle.cleared`: null → null (admin clearing login throttles, metadata: scope, clearedCount).
- `email_change.requested`: null → null (user requesting email change, metadata: domain).
- `email_change.confirmed`: null → null (user confirming email change).
