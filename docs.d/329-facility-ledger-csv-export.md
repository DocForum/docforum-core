---
file: docs/api/README.md
after: "| `GET /payments/facility/ledger` | facility |"
---
| `GET /payments/facility/ledger.csv` | facility | `status`, `from`, `to` | Issue #329. The same rows and order as the ledger, as a streamed `text/csv` download (`attachment; filename="facility-ledger.csv"`). Columns: `date,intent_id,status,asset,amount_smallest_unit,amount,transaction_hash`. Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` (formula-injection guard). `limit`/`cursor` are rejected (`400`): the export covers every matching row. |
