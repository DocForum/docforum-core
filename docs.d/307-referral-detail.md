---
file: docs/api/README.md
section: Referrals (/referrals) — backend/src/modules/referrals
---
| `GET /referrals/:referralId` | patient (own, or guardian with `?patientProfileId=`), referring doctor, current target doctor, admin | query: `patientProfileId?` | Issue #307 — one referral row, including `status`, `expiredAt`, `expiredReason`, `cancelledReason` and `resultingAppointmentId`; `snapshotNotes` is returned in readable form. Everyone else receives `404`; registered after `/incoming`, `/mine`, `/created` and `/admin/*` so those routes keep matching. Successful reads are recorded in the PHI access log. |
