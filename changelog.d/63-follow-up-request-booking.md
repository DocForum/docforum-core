Phase 2: follow-up outcome creates a pre-filled booking request
([issue #63](https://github.com/DocForum/docforum-core/issues/63)).
`follow_up_needed` now creates a `FollowUpRequest` with an immutable encrypted
note snapshot and the patient's latest intake id. `GET /follow-ups/mine` and
`POST /follow-ups/:id/book` let the patient book through the existing
conditional slot claim (new appointment origin `follow_up`); an interval sweep
expires unbooked requests past their window.
