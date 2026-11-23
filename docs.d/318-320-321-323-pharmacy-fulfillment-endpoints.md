---
file: docs/api/README.md
section: Pharmacy orders (/pharmacy-orders) — backend/src/modules/pharmacy-orders
---
| `GET /pharmacy-orders/orders/:orderId/fulfillments?orderType=prescription\|lab_order` | patient\|facility\|admin | — | Lists fulfillment records for one order (issue #323). Patient sees only their own orders; facility sees only its own records. |
