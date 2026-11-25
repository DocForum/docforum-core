---
file: docs/api/README.md
after: "| `GET /orders/lab-orders/:labOrderId/result` |"
---
| `GET /orders/lab-orders/:labOrderId/result` | patient (own order), ordering doctor, fulfilling facility; active guardian with `?patientProfileId=` | query: `patientProfileId` (uuid, optional) | Issue #305: naming a dependent downloads that dependent's result file with `resolveActingProfile` authorisation; `403 GUARDIANSHIP_INACTIVE` after revocation/majority, `404` for an unrelated profile. The access log names the guardian as viewer and uses detail `lab result file download (guardian)`. |
