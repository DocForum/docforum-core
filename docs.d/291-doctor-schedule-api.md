---
file: docs/api/README.md
section: Appointments (/appointments) — backend/src/modules/appointments
---
| `GET /appointments/doctor` | doctor | — | Caller's appointments over an arbitrary date range (`?from=&to=&status=`, capped at 31 days), interpreted in their profile `timeZone`. Returns slot times and patient display name with zero clinical details. Cancelled appointments that released their slot return with `slot: null`. |
