Phase 5.5: admin list of payment intents with filters
([issue #325](https://github.com/DocForum/docforum-core/issues/325)).
`GET /payments/intents` (admin-only) added with filters for status, assetCode,
facilityId, patientProfileId, and created date range. Keyset-paginated (base64url
cursor, same encoding as the existing patient/facility history endpoints). Amounts
are serialised as strings (BigInt-safe). Uses existing DB indexes.
