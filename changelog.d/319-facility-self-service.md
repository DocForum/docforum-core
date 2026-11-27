Phase 5: facility self-service profile
([issue #319](https://github.com/DocForum/docforum-core/issues/319)).
`GET /facilities/me` returns the caller's facility profile with a version
`ETag`; `PATCH /facilities/me` updates `name`, `address`, `latitude` and
`longitude` with `If-Match` (`428` without it, `412` on a stale version)
through a conditional update on `FacilityProfile.version`, and writes a
`facility.profile_updated` audit event. Coordinates change together or not at
all, within the same bounds as the `near` search parameter; `type` stays
admin-only. Integration tests in `facility-self-service.test.mts` (port 5495).
