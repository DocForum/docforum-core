---
file: docs/api/README.md
after: "| `POST /referrals/:referralId/decline` | patient (the referred patient) | — |"
---
| `POST /referrals/:referralId/withdraw` | doctor (the referring doctor) | `{ reason }` | Issue #308 — pending only, with a required 1–200 character reason. Reuses the existing `cancelled` status and `cancelledReason` column; accepted or terminal referrals and a lost race with accept return `409`, another doctor's referral or an unknown id returns `404`. One conditional `pending → cancelled` UPDATE (also requiring `resultingAppointmentId IS NULL`) and a `referral.withdraw` AuditEvent commit together; the reason lives in `metadata.reason`. |
