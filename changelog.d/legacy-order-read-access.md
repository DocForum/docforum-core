Orders: legacy `Order` reads use the same viewer rule as prescription and
lab-order reads. `GET /orders/:id` and `GET /pharmacy-orders/:id` answer the
order's patient (or an active guardian), its prescribing doctor, the facility
it is routed to and admins, write an AccessLog row, and return `404` to anyone
else; `GET /pharmacy-orders/orders/:orderId/fulfillment-status` follows
`canViewOrder`. Legacy `POST /pharmacy-orders` and `POST /lab-orders` are
admin-only, since clinical orders are issued through the consultation-scoped
`/orders/consultations/...` routes. All four reads are rate-limited.
