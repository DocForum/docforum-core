---
file: docs/api/README.md
section: Appointments (`/appointments`) — `backend/src/modules/appointments`
---
| `GET /calendar/:token.ics` | feed token (bearer URL) | Subscribe to the absolute URL returned by `POST /doctors/me/calendar-feed` in your calendar provider's Internet-calendar settings. Events contain only `DocForum appointment`, UTC start/end times and a DocForum appointment link; cancellations are sent as `STATUS:CANCELLED`. No patient, intake or reason data is included. Supports `ETag` and `Last-Modified`; treat the URL as a password. |
