---
file: ROADMAP.md
section: Phase 3 — Referrals
---
- [x] Incoming referrals inbox for target doctors (issue #306): `GET /referrals/incoming` is doctor-only, scoped to the caller's current `targetDoctorId`, defaults to `pending`/`accepted` with an explicit `status` filter for terminal referrals, and is keyset-paginated via `(createdAt, id)`. Snapshot notes are decrypted for the intended reader and each returned row writes a PHI access log; admin reassignment moves rows between inboxes automatically. Closes [issue #306](https://github.com/DocForum/docforum-core/issues/306).
