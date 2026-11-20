---
file: ARCHITECTURE.md
section: 4.5 Prescriptions (versioned, append-only)
---
### Medication catalog (Phase 4, issue #69)
```
Medication                          # reference data, not clinical advice
  id, generic_name, strength, form, route
  external_code (nullable, unique)  # whatever open code the importer's
                                    # source provides; openFDA NDC = the
                                    # NDC product code. RxNorm CUIs are NOT
                                    # used — they are not openly licensed.
  created_at, updated_at
  # unique (generic_name, strength, form, route) — the identity the importer
  # upserts on. GIN trigram index on generic_name (pg_trgm) backs the
  # autocomplete; the extension is created by the migration because Prisma
  # has no extension syntax, the index is declared in the schema so the
  # drift check does not see a phantom index.

PrescriptionItem (extended)
  medication_id (nullable FK)          # null = unlisted medication
  flagged_for_pharmacist_review        # true exactly when medication_id is null
  drug_name                            # UNCHANGED: the display snapshot,
                                       # "Amoxicillin 500 mg capsule"
```
The catalog is a **picker, never a checker**: it gives prescribers a controlled
vocabulary and pharmacies an unambiguous line, and it deliberately does not
evaluate interactions (PRD §8.2.8). Issuance snapshots `generic_name +
strength + form` into the append-only `drug_name`; a later catalog edit (or an
importer re-run) does not rewrite an issued prescription — same hard rule as
the rest of §4.5. An item with no `medication_id` is the explicit
unlisted-medication path: the prescriber's free text is kept verbatim and the
row is flagged for pharmacist review, so "not in the catalog" is a recorded
decision rather than an invisible one. Other modules read the catalog only
through `medications/services` (AGENTS.md module boundary); the model lives in
`prisma/schema/facilities.prisma` because it is reference data the
facility/pharmacy side owns.
