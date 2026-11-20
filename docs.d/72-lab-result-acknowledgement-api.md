---
file: docs/api/README.md
after: "| `GET /orders/lab-orders/:labOrderId/result` | patient (own order), ordering doctor, fulfilling facility |"
---
| `POST /lab-results/:labResultId/acknowledge` | doctor (the ordering doctor only) | — | Acknowledges an `abnormal`/`critical` result once via a conditional UPDATE. `200` with the acknowledgement row; a repeat is `409`. Anyone else (including another doctor) gets the same `404` as a missing task. Writes a `lab_result.acknowledged` audit event. |
| `GET /lab-results/unacknowledged` | doctor, admin | `limit` (1–100, default 50) | Doctors see their own outstanding tasks; admins see the escalation queue (everything escalated or past its deadline). Items carry `labResultId`, `labOrderId`, `orderingDoctorId`, `severity`, `escalationDueAt`, `escalatedAt`, `overdue` (derived from the deadline) and `createdAt`. |
