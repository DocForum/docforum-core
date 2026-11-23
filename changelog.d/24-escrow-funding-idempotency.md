Phase 5.5: escrow funding is idempotent and reconcilable (closes
[issue #24](https://github.com/DocForum/docforum-core/issues/24)).
`fundPaymentIntent` now claims the intent `created -> funding` with one
conditional UPDATE that commits before `create_escrow`; of N concurrent fund
requests exactly one reaches the chain and the rest get `409` (proven with 8
concurrent requests against embedded Postgres and a fake SDK). A failed chain
call returns the intent to `created` and audits it; a crash between the call
and the settle write leaves `funding`, which `npm run reconcile:escrows`
reports and resolves explicitly (`--adopt` an escrow the event poller
observed, or `--abandon` a claim that never reached the chain). New
`funding` status and `fundingStartedAt` column; the admin history filter
accepts `status=funding`. No automatic retry of the chain call — that could
create a second escrow.
