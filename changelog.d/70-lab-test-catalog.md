Phase 4: Lab test catalog and capability matching by test code
(issue #70).

Added `LabTest` model with code (LOINC/local), name, specimen type, category,
and panel support via self-referential `panelOf` relation. `LabOrderTestCode`
join table links lab orders to test codes with snapshot (`testCode`, `testName`).
`FacilityCapability.labTestId` enables code-based matching for
facility eligibility. `GET /lab-tests?q=` autocomplete with trigram search.
Import script at `backend/scripts/import-lab-tests.mjs`. Integration tests in
`backend/tests/integration/lab-test-catalog.test.mts`.