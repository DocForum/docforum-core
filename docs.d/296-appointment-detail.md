---
file: docs/api/README.md
section: Appointments (/appointments) — backend/src/modules/appointments
---
| `GET /appointments/:id` | patient, guardian, treating doctor | — | Role-scoped appointment detail read. Returns appointment with slot times (`slot`), doctor summary (`doctor`), and origin. Only the owning patient, an active guardian of a dependent patient, or the treating doctor may access; all other callers (including admins, for clinical privacy) receive `404`. Cancelled appointments with a released slot return `slot: null`. Emits strong `ETag` carrying the appointment's integer `version`. |
