---
file: docs/api/README.md
after: "| `GET /doctors` | none |"
---
| `GET /doctors/:doctorProfileId` | none | Public detail for one verified, active doctor. Returns `{ id, fullName, nextAvailableAt, specialties: [{ id, name, slug }] }`. Returns `404` for unknown, unverified or deactivated doctors. |
