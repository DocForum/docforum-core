Phase 2: symptom-to-specialty mapping for "search by symptom" (closes
[issue #60](https://github.com/DocForum/docforum-core/issues/60)). A curated
`Symptom` / `SymptomSpecialty` vocabulary (weights 1–5, admin-managed,
reviewed starter set in the migration) with `GET /symptoms?q=` autocomplete
(prefix + trigram, retired symptoms hidden), `GET /doctors?symptom=<slug>`
ranked by mapping strength, and admin CRUD at `/admin/symptoms` (create,
rename/retire, replace mappings; all audited). Explicitly not ML
(PRD §8.3.3) and never presented as medical advice. An unknown, retired or
unmapped symptom is `200` with empty `items` and a `hint`, not an error. New
models documented in `ARCHITECTURE.md` §4.15; endpoints in
`docs/api/README.md`.
