---
file: docs/api/README.md
section: Doctors (`/doctors`) — `backend/src/modules/doctors`
---
| `POST /doctors/me/calendar-feed` | doctor | Rotates the caller's feed token and returns `{ feedUrl }`; the previous URL is invalid immediately. The raw token is only returned in this response. |
| `DELETE /doctors/me/calendar-feed` | doctor | Revokes the caller's current feed URL; repeated revocation is safe. |
