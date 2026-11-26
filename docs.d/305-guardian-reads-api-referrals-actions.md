---
file: docs/api/README.md
after: "| `POST /referrals/:referralId/accept` |"
---
| `POST /referrals/:referralId/accept` | patient (the referred patient); active guardian with `patientProfileId` in the body | `{ availabilitySlotId, patientProfileId? }` | Issue #305: a guardian accepts a dependent's referral through `resolveActingProfile`; `403 GUARDIANSHIP_INACTIVE` after revocation/majority, `404` for an unrelated profile. The appointment is booked for the dependent and the audit row carries that profile id in its metadata. |
| `POST /referrals/:referralId/decline` | patient (the referred patient); active guardian with `patientProfileId` in the body | `{ patientProfileId? }` | Issue #305: same authorisation as accept; pending-only, terminal. The `referral.declined` audit row carries the acted-for profile id. |
