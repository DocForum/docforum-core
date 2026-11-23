---
file: docs/api/README.md
section: Escrow chain events (/admin/payments/escrow-events)
---
Pagination (issue #327): events are ordered newest first (`detectedAt` desc, then `id` desc). Pass the response's `nextCursor` back as `?cursor=` to fetch the next page; `nextCursor` is `null` on the last page, and a malformed cursor is `400 INVALID_CURSOR`. `cursor` combines with `state`. An event with no matching payment intent is flagged by `state: unmatched` with `paymentIntentId: null` and `alertedAt` set; `pending` events are not yet judged.
