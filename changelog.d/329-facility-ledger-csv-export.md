Phase 5.5: CSV export of the facility payout ledger
([issue #329](https://github.com/DocForum/docforum-core/issues/329)).
`GET /payments/facility/ledger.csv` takes the ledger's `status`, `from` and
`to` filters and returns the same rows as `GET /payments/facility/ledger`.
Columns: date, intent id, status, asset, amount in the smallest unit, decimal
amount, transaction hash. It is streamed in keyset pages of 500, so memory
stays flat for any date range. Every cell is escaped against spreadsheet
formula injection (`=`, `+`, `-`, `@`, tab and CR get a leading `'`) by
`src/utils/csv.ts`. No schema changes.
