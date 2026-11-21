---
file: docs/api/README.md
after: "| `GET /consultations/:consultationId` | doctor (treating) or patient (own visit) | — | Anyone else gets `403`; unknown id `404`. `notes` comes back decrypted. |"
---
| `GET /consultations/mine` | patient (own consultations, or guardian with `?patientProfileId=`) | — | Keyset-paginated list of the caller's consultation summaries, newest first. Query: `patientProfileId`, `limit` (default 20), `cursor`. Returns `{ items: [{ id, appointmentId, date, doctorName, outcome, createdAt }], nextCursor }`. Notes are omitted. |
| `GET /consultations/doctor` | doctor (treating doctor, verified email) | — | Keyset-paginated list of the caller's consultation summaries, newest first. Query: `limit` (default 20), `cursor`. Returns `{ items: [{ id, appointmentId, date, patientName, outcome, createdAt }], nextCursor }`. Anonymised patients show as `Deleted patient`. Notes are omitted. |
