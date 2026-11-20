---
file: ROADMAP.md
section: Phase 4 — Orders: prescriptions & lab orders
---
- [x] Medication catalog: a controlled prescription vocabulary imported from
  openFDA NDC (public domain; `backend/scripts/import-medications.mjs`,
  licence-checked before import) with `GET /medications?q=` autocomplete over
  a trigram index, and `PrescriptionItem.medicationId` plus a
  pharmacist-review flag for the explicit unlisted-medication path. The
  issued `drugName` stays a display snapshot, so catalog edits never rewrite
  an issued prescription. The 30k-row autocomplete p95 is asserted under
  500 ms in `backend/tests/integration/medications.test.mts`. Tracked as
  [issue #69](https://github.com/DocForum/docforum-core/issues/69)
  (High, 200 pts) — **Done**. The catalog is a picker, not an interaction
  checker (PRD §8.2.8 stays deferred).
