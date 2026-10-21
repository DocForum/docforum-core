Phase 4: Medication catalog (controlled vocabulary) for structured prescriptions
(issue #69).

Added `Medication` model with generic name, strength, form, route, external code
(RxNorm/local formulary). Created `backend/scripts/import-medications.mjs` for
licence-checked dataset import. Added `GET /medications?q=` autocomplete
endpoint with PostgreSQL trigram similarity search. `PrescriptionItem` now has
optional `medicationId` FK with snapshot fields (`medicationName`,
`medicationStrength`, `medicationForm`, `medicationRoute`) per append-only
rule. Explicit unlisted medication path via free-text `drugName` when
`medicationId` omitted. Dataset licence documented in `docs/LICENSE-DATASET.md`.
Integration tests in `backend/tests/integration/medication-catalog.test.mts`.