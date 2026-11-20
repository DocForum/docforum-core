---
file: docs/api/README.md
section: Specialties (/specialties) — backend/src/modules/doctors
---
| `GET /admin/specialties` | admin | Lists all specialties in the catalog, including retired ones (`isRetired: true`). |
| `POST /admin/specialties` | admin | Body `{ name: string, slug?: string }`. Creates a new specialty (slug is generated if omitted). Audited (`specialty.created`). `409` on duplicate name or slug. |
| `PATCH /admin/specialties/:id` | admin | Body `{ name?: string, isRetired?: boolean }`. Renames a specialty; slug stays immutable. Audited (`specialty.renamed`). `409` on duplicate name. |
| `POST /admin/specialties/:id/retire` | admin | Retires a specialty (`isRetired: true`). Retired specialties disappear from public `GET /specialties` and cannot be newly assigned to doctors, but existing links and referrals keep working. Audited (`specialty.retired`). |
