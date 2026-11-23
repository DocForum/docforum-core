---
file: ARCHITECTURE.md
section: 4. Data models
---
### 4.15 Symptom -> specialty mapping (Phase 2, issue #60)

A curated, admin-managed controlled vocabulary — **not** a diagnosis aid and
**not** ML (PRD §8.3.3 keeps ML matching out of v1). It exists so a patient
who does not know which specialty a complaint belongs to can still search:
"rash" resolves to the specialties a human reviewed and weighted.

```
Symptom
  id, name (unique), slug (unique), is_retired, created_at, updated_at
  # GIN trigram index on name for GET /symptoms?q= autocomplete.

SymptomSpecialty
  id, symptom_id (FK cascade), specialty_id (FK cascade), weight, created_at
  unique(symptom_id, specialty_id); index(specialty_id)
  # weight is mapping strength 1-5, enforced by a CHECK constraint as well as
  # the API. It says "how strongly this complaint points at this specialty",
  # nothing about the patient.

Doctor search (`GET /doctors?symptom=<slug>`)
  # Resolve the slug to its mappings, then rank verified doctors by the
    strongest mapped specialty they hold (score = max weight), tie-broken by
    doctor id. If the slug is unknown, retired, or the symptom has no
    mappings, the response is 200 with `items: []` and a `hint` — not an
    error and not an empty list with no explanation.
```

No PHI is stored here. The vocabulary is public (autocomplete), the mapping
is admin-only to write, and every mapping write is audited
(`entity_type: 'Symptom'`) in the same transaction. The starter vocabulary
is inserted by the `symptom_specialty_mapping` migration and is deliberately
small: each row points from a plain-language complaint to an existing
specialty, and a mapping is a **search aid** — it must never be presented as
medical guidance.
