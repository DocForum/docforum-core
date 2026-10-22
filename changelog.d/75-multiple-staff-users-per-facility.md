Phase 5: multiple staff users per facility with fixed roles
([issue #75](https://github.com/DocForum/docforum-core/issues/75)).

`FacilityMember` gives a facility several staff accounts where `FacilityProfile`
was 1:1 with `User` — exactly two roles (`owner`/`staff`, no permissions
matrix), `userId` unique so a user belongs to at most one facility, and the
`add_facility_member_and_invite` migration backfills every pre-existing
facility profile as an `owner` so existing logins keep their access.
`FacilityInvite` issues staff-only invite tokens stored only as SHA-256
hashes, expiring after `FACILITY_INVITE_TTL_MINUTES` (default 4320) and
consumed with a conditional update (single-use). New `/facilities` routes
list/remove members and create/list/revoke invites, guarded by
`requireFacility`/`requireFacilityOwner`; accepting an invite does not
require an access token, because a brand-new staff member doesn't have an
account yet. `FulfillmentRecord.actorUserId` is the attribution column for
"who fulfilled this" — nullable, set by the fulfillment service when those
actions land (#14/#15).

Two notes for whoever picks up facilities next: there is still no admin
facility-creation flow (issue #14 is open), so `FacilityProfile` rows are
created directly in tests today; and the "never remove the last owner" rule
is enforced in the service layer only (no DB trigger) — see
ARCHITECTURE.md §6.2.6.
