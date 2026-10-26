# Success metrics

`GET /admin/metrics?from=<RFC3339>&to=<RFC3339>` accepts offset-aware timestamps, converts them to UTC, and uses a half-open interval (`from <= appointment time < to`). Ranges are limited to 366 days. The endpoint is admin-only and returns aggregate values, never row or patient data. A cell with fewer than five eligible appointments is suppressed.

| Metric | Numerator | Denominator / window | Availability |
| --- | --- | --- | --- |
| No-show rate | Appointments with status `no_show` | Appointments with status `completed` or `no_show`, by scheduled start time in the requested interval | Available when denominator is at least five |
| Booking lead time | Not applicable (mean) | Mean of `slot.startTime - appointment.createdAt`, for completed/no-show appointments by scheduled start time in the interval | Available when at least five records qualify; reported in days |
| Symptom to order | Not available | The system does not store a symptom-opened timestamp | Not yet available |
| Referral completion | Not available | A product-approved cohort/window definition is not yet instrumented | Not yet available |
| Fulfilled within N days | Not available | The endpoint lacks an agreed N and common issued-order source across order types | Not yet available |

The query reads a plain SQL view over appointments and availability slots. It stays current without a refresh job and does not refresh or lock booking tables. Cancelled and future scheduled appointments are excluded from the two available metrics. These are operational measures, not clinical outcome claims.
