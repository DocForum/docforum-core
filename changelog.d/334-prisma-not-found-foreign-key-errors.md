Phase 9: Prisma not-found and foreign-key errors no longer surface as 500
([issue #334](https://github.com/DocForum/docforum-core/issues/334)).
The error handler maps `P2025` to `404 Record not found.` and `P2003` to
`422 The request refers to a record that does not exist or is still in use.`
(alongside the existing `P2002` → `409`), from a single
`PRISMA_CLIENT_ERRORS` table. Messages are fixed strings: Prisma's message and
`meta` (table, column and constraint names) are only logged. Errors thrown
inside `$transaction` map the same way. Referral creation now checks the
target specialty exists first and answers
`422 SPECIALTY_NOT_FOUND` instead of the misleading "no verified doctor"
error. Postgres `ON DELETE RESTRICT` refusals (SQLSTATE 23001) arrive as an
*unknown* Prisma error and still return 500; call sites that can hit them
already catch them (`isForeignKeyRefusal`). Tests:
`backend/tests/unit/error-handler-prisma.test.ts`,
`backend/tests/integration/prisma-errors.test.mts` (real Postgres, one per
mapped code, inside and outside transactions) and a case in
`referral-routing.test.mts`.
