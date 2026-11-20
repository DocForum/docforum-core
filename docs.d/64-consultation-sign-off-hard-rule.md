---
file: ARCHITECTURE_ESSENTIALS.md
section: Hard rules (violating these = request changes on the PR)
---
8. **A signed `Consultation` note is immutable.** Once `signedAt` is set, the
   note and the sign-off cannot change (repository conditional UPDATE + DB
   trigger); corrections are new append-only `ConsultationAddendum` rows.
   Consultation messages and addenda are append-only in the same way.
