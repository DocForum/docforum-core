---
file: ROADMAP.md
section: Phase 2 — Intake, appointments, consultations
---
- [x] Symptom-to-specialty mapping for "search by symptom" ([issue #60](https://github.com/DocForum/docforum-core/issues/60)): a curated `Symptom` → `SymptomSpecialty` vocabulary (weights 1–5, admin-managed, starter set in the migration), `GET /symptoms?q=` autocomplete, `GET /doctors?symptom=` ranked by mapping strength, and admin CRUD at `/admin/symptoms`. Explicitly not ML (PRD §8.3.3) and never presented as medical advice; an unknown/retired/unmapped symptom is an empty result plus a `hint`, not an error. Models documented in ARCHITECTURE.md §4.15.
