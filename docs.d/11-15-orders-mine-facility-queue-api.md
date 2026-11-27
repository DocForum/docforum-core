---
file: docs/api/README.md
section: Orders (/orders) — backend/src/modules/orders
---
| `GET /orders/mine` | patient | — | Returns the caller's non-superseded prescriptions and lab orders (supersedes-chain resolved at query level). |

---
file: docs/api/README.md
section: Pharmacy Orders (/pharmacy-orders) — backend/src/modules/pharmacy-orders
---
| `GET /pharmacy-orders/facility/queue` | facility | — | Returns all FulfillmentRecords assigned to the calling facility. `fulfilled` is never directly settable here. |
