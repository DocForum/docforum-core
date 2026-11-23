---
file: docs/api/README.md
after: "| `POST /facilities/me/prices` | facility (verified email) |"
---
| `GET /facilities/me` | facility | — | The caller's own facility profile: `{ id, version, userId, name, type, address, latitude, longitude, createdAt, updatedAt }`. Returns `ETag: "<version>"` for optimistic concurrency (issue #319). |
| `PATCH /facilities/me` | facility | `{ name?, address?, latitude?, longitude? }` | Updates the caller's own facility profile. Requires `If-Match: "<version>"` from a prior `GET /facilities/me` (412 without it, 412 on stale version). At least one field must be provided (400 otherwise). Returns the updated profile + fresh `ETag`. Writes a `facility.profile_updated` audit event (issue #319). |
