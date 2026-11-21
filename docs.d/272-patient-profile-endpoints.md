---
file: docs/api/README.md
section: Patients (/patients) — backend/src/modules/patients
---
| `GET /patients/me` | patient | Authenticated patient. Returns caller's profile with strong `ETag` matching `version`. Refuses anonymized profiles (404). |
| `PATCH /patients/me` | patient | Authenticated patient. Body `{ fullName?, dateOfBirth? }`. Requires `If-Match` header with current version (428/412). Executes single conditional UPDATE on version and anonymizedAt null. |
