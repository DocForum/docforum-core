---
file: ARCHITECTURE_ESSENTIALS.md
section: Data model map (see ARCHITECTURE.md §4 for full field lists)
---
`Symptom` → `SymptomSpecialty` (issue #60 — curated, admin-managed symptom →
specialty guidance with a 1–5 weight; public autocomplete via `/symptoms`,
doctor search via `GET /doctors?symptom=<slug>` ranked by weight. A search
aid, not a diagnosis and not ML; no PHI in either table — see ARCHITECTURE.md §4.15)
