---
file: docs/api/README.md
section: Doctors (/doctors) — backend/src/modules/doctors
---
| `GET /admin/doctors/verification-queue` | admin | Query: optional `kind` (`profile`\|`specialty`), `specialty` (id or slug), `limit` (default 20, max 100), keyset `cursor`. Returns pending doctor profiles and pending doctor specialty assignments ordered oldest first, with non-clinical review data, queue age in seconds, and `isDeactivated` flag. |
| `PATCH /doctors/:doctorProfileId/specialties/:specialtyId/verification` | admin | Body `{ status: 'pending'\|'verified'\|'rejected', rejectionReason? }`. Reviewer identity is derived server-side from authenticated admin; `reviewDate` is set server-side. Requires `rejectionReason` (up to 200 chars) when rejecting. Emits transactional `AuditEvent` (`doctor_specialty.verification_changed`); no-op if status is unchanged. |
