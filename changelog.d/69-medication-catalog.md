Phase 4: medication catalog
([issue #69](https://github.com/DocForum/docforum-core/issues/69)).
New `medications` module with `GET /medications?q=` autocomplete (trigram
index, 30k-row p95 asserted under 500 ms) and a `Medication` model imported by
`backend/scripts/import-medications.mjs` from openFDA NDC — public-domain
source, licence checked before import; RxNorm is deliberately not used because
its CUIs are not openly licensed. `PrescriptionItem` gains `medicationId` and
`flaggedForPharmacistReview`: prescribing from the catalog snapshots
"generic name + strength + form" into the unchanged `drugName` display field,
while an unlisted medicine keeps the prescriber's free text and is flagged for
pharmacist review. An unknown `medicationId` is a `400` before any row is
written, and catalog edits never rewrite an issued prescription. The catalog
is a picker, not an interaction checker (PRD §8.2.8 stays deferred). Migration
`20261120111332_medication_catalog` creates `pg_trgm` and the GIN index; tests
in `backend/tests/integration/medications.test.mts`.
