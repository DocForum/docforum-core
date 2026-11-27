Phase 9: machine-readable error codes and a generated error catalogue
([issue #115](https://github.com/DocForum/docforum-core/issues/115)).
`HttpError` now takes a required code from `backend/src/error-catalogue.ts`
(about 320 codes grouped per module) and derives its HTTP status from the
catalogue, so a code can never answer with a different status than the docs
say. Every `HttpError` construction in `src/` was converted; `npm run
errors:lint` fails CI on an uncoded one, and `npm run errors:check` also fails
when the generated page is stale. The envelope is `{ code, message, details? }`
on every error path. Zod failures are `400 VALIDATION_FAILED` with
`details.fields[]` (per-field `path`, `code`, `message`); a refinement that
carries a catalogue code such as `PASSWORD_TOO_SHORT` keeps that code at the
top level, as before. Prisma's client-fault
errors are `DUPLICATE_RECORD` / `INVALID_REFERENCE` / `NOT_FOUND`, and unknown
errors are `500 INTERNAL` with no internals leaked. `message` is unchanged and
still sent for backwards compatibility. `docs/api/error-catalogue.md` is
generated from the catalogue with `npm run errors:catalogue`; the docs site's
error page now copies it instead of a hand-written list that had drifted from
the real API. No schema changes and no new endpoints.
