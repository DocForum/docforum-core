---
file: docs/api/README.md
after: "| `GET /consultations/:consultationId` |"
---
| `GET /consultations/:consultationId` | doctor (treating) or patient (own visit); active guardian with `?patientProfileId=` | query: `patientProfileId` (uuid, optional) | Issue #305: without the parameter, existing behaviour is unchanged. Naming a dependent reads their consultation (notes + addenda decrypted) only while the guardianship is active — `403 GUARDIANSHIP_INACTIVE` once revoked or at majority, `404` for an unrelated profile. Every successful read writes a PHI access log naming the viewer. |
