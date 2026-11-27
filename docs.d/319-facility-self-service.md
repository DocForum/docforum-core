---
file: docs/api/README.md
after: "| `POST /facilities/me/prices` | facility (verified email) |"
---
| `GET /facilities/me` | facility | — | The caller's own facility profile: `{ id, version, userId, name, type, address, latitude, longitude, createdAt, updatedAt }`, with `ETag: "<version>"` (issue #319). |
| `PATCH /facilities/me` | facility | `{ name?, address?, latitude?, longitude? }` | Updates the caller's own profile. Requires `If-Match: "<version>"` from a prior `GET /facilities/me`: `428` without it, `400` if malformed, `412 VERSION_CONFLICT` on a stale version. At least one field; `latitude` and `longitude` only together, within -90..90 / -180..180 (same as `near`); `type` is not editable (`400`). Returns the updated profile and a fresh `ETag`; writes a `facility.profile_updated` audit event. |
