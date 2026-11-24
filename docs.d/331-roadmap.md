---
file: ROADMAP.md
section: Phase 6 — Notifications
---
- [x] Integration tests for the notification SSE endpoint (issue #331): 401, exact per-user cap (`429 STREAM_LIMIT`), heartbeats, published-event delivery, `token-expired`, unsubscribe on disconnect. `backend/tests/integration/notification-stream.test.mts`.
