---
file: docs/api/README.md
section: Orders (`/orders`) — `backend/src/modules/orders`
---
## Medications (`/medications`) — `backend/src/modules/medications`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `GET /medications?q=` | access token, any role | — | Autocomplete over the controlled medication vocabulary (issue #69). `q` is 2–100 characters, `limit` defaults to 20 (max 50). `200 { medications: [{ id, displayName, genericName, strength, form, route, externalCode }] }`; `displayName` is exactly what an issued prescription item will snapshot. `400 MEDICATION_QUERY_TOO_SHORT` below two characters (the trigram index is not selective enough to be worth it). Authenticated but not role-restricted: the catalog is public reference data, not PHI. |

Prescription items accept `medicationId` (from this endpoint) **or**
`drugName` (an unlisted medication), never neither. With `medicationId` the
catalog row's display name is snapshotted into the item and the item is not
flagged; with `drugName` the text is kept verbatim and
`flaggedForPharmacistReview` is set, so a pharmacy can tell an unlisted
medicine from a catalog one. An unknown `medicationId` is a `400` before any
row is written. The snapshot is never re-derived from the catalog afterwards.
