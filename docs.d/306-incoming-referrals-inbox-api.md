---
file: docs/api/README.md
after: "| `GET /referrals/created` |"
---
| `GET /referrals/incoming` | doctor (the referral's current target) | query: `status`, `limit` (1–50, default 20), `cursor` | Issue #306: `{ items, nextCursor }`, newest first, keyset-paginated on `(createdAt, id)` through the existing `targetDoctorId` index. Defaults to `pending` + `accepted`; `expired`, `cancelled`, `declined` and `completed` need an explicit `status=...` filter. `snapshotNotes` is returned decrypted when field encryption lands. Each returned referral writes a PHI `AccessLog` row with the target doctor as viewer. Admin reassignment changes `targetDoctorId`, so a moved referral disappears from the old target's inbox and appears in the new target's. |
