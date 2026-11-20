---
file: ARCHITECTURE.md
section: 4.1 User / Role model
---
Specialty and DoctorSpecialty updates (issue #281, #282):
- `Specialty` gains `isRetired` (boolean, default false). Retired specialties disappear from public listing and cannot be newly assigned.
- `DoctorSpecialty` includes `verificationStatus` (enum: pending|verified|rejected), `reviewer`, `reviewDate`, `rejectionReason`, and `createdAt` for queue age ordering.
