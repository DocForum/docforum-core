---
file: docs/api/README.md
after: "| `GET /doctors/me` | doctor |"
---
| `PATCH /doctors/me` | doctor | Updates the caller's own `DoctorProfile` under optimistic concurrency (`If-Match: "<version>"`). Body `{ fullName?: string, timeZone?: string }`, requiring at least one field. `timeZone` must be a canonical IANA time zone identifier (or `UTC`). Modifying `timeZone` preserves the absolute UTC timestamps of existing slots and appointments. |
