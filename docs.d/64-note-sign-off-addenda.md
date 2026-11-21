---
file: ARCHITECTURE.md
section: 4.3 Consultation
---
**Phase 2, issue #64 — note sign-off and append-only addenda (implemented
2026-11-20).** `Consultation.signedAt` is null while the note is editable. The
authoring doctor edits it with `PATCH /consultations/:id/notes` (one
conditional `UPDATE ... WHERE signedAt IS NULL`) and signs with
`POST /consultations/:id/sign-off` (once). After sign-off the repository
refuses edits and a DB trigger rejects any UPDATE that changes `notes` or
`signedAt`, including one issued directly through Prisma — so a correction is
a new row:
```
ConsultationAddendum
  id, consultation_id (FK, RESTRICT), author_user_id (FK, RESTRICT)
  body [ENCRYPTED], created_at
```
Addenda are append-only (trigger rejects UPDATE/DELETE/TRUNCATE), writable only
by the authoring doctor and only after sign-off; `GET /consultations/:id`
returns `signedAt` plus the note and its addenda in creation order. Notes left
unsigned for `CONSULTATION_AUTO_SIGN_OFF_HOURS` (24) after the consultation was
closed are signed by `src/jobs/consultation-sign-off.ts` (runs under the RLS
bypass role). A referral may still be created before sign-off; it takes an
immutable copy of the note as it stands, which §4.4 already requires.
