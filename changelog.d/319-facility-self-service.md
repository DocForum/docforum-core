Facility self-service profile read and update: GET/PATCH /facilities/me
([issue #319](https://github.com/DocForum/docforum-core/issues/319)).
Facilities can now read their own full profile (`GET /facilities/me`, returns
ETag) and update `name`, `address`, `latitude`, `longitude` with optimistic
concurrency (`PATCH /facilities/me`, requires `If-Match`). The update uses the
`version Int @default(1)` column already on `FacilityProfile` with the same
`updateManyAndReturn` conditional-update pattern as patients and doctors, and
records a `facility.profile_updated` audit event. New `facilityUpdateSchema` in
`facilities/validation.ts`; new `updateFacilityProfile` repo function; new
`getOwnFacilityProfile` / `updateOwnFacilityProfile` service functions.
