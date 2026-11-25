---
file: docs/api/README.md
after: "| `GET /referrals/mine` |"
---
| `GET /referrals/mine` | patient; active guardian with `?patientProfileId=` | query: `patientProfileId` (uuid, optional) | Issue #305: lists the named dependent's referrals with the same `{ referrals, groupedByConsultation }` shape. `403 GUARDIANSHIP_INACTIVE` after revocation/majority, `404` for an unrelated profile. Guardian reads are PHI-access-logged. |
