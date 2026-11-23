---
file: docs/api/README.md
after: "| `GET /specialties` | none | Lists the seeded specialty catalog as `{ id, name, slug }` records. |"
---
## Symptoms (`/symptoms`) — `backend/src/modules/doctors`

Curated symptom vocabulary (issue #60) used by `GET /doctors?symptom=`. It is
reviewed, admin-managed guidance for finding a specialty — not a diagnosis and
not an automated triage tool. Retired symptoms are hidden from search.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /symptoms` | none | Query: optional `q` (prefix match for short terms, `pg_trgm` similarity for 3+ characters), `limit` (1–50, default 10). Returns `{ items: [{ id, name, slug }] }`; without `q` it lists the active vocabulary alphabetically. |
| `GET /admin/symptoms` | admin | Every symptom, including retired, with its `specialties: [{ specialtyId, weight, specialty: { name, slug } }]`. |
| `POST /admin/symptoms` | admin | Body `{ name, slug? }` (`slug` derived from `name` when omitted). `409` on a duplicate name or slug. |
| `PATCH /admin/symptoms/:id` | admin | Body `{ name?, isRetired? }`; at least one field is required. Audits rename/retire/unretire. |
| `PUT /admin/symptoms/:id/specialties` | admin | Body `{ mappings: [{ specialtyId, weight }] }`, `weight` 1–5. **Replaces** the whole mapping set (an omitted specialty becomes unmapped); duplicate ids keep the highest weight. Unknown specialty ids and out-of-range weights are `400`. |
