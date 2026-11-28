Phase 2: platform and clinic closure calendar that blocks slot generation
([issue #131](https://github.com/DocForum/docforum-core/issues/131)).

New `ClosurePeriod` model (`scope: platform|facility`, inclusive all-day range
plus the IANA `timeZone` those days are read in, reason). Creating or extending
a closure removes the still-open slots in its window with one conditional
`DELETE` (`status = 'open'` AND no appointment) and REPORTS the booked
appointments in the response — it never cancels them. Slot generation skips
closed days (`skippedClosed` in the generate response) and the public slot list
filters them out. Endpoints: public `GET /availability/closures`, admin CRUD at
`/availability/admin/closures` (`If-Match`-guarded PATCH, audited writes).
Migration `20261128120000_closure_calendar` adds the table plus CHECK
constraints for scope/facility consistency and a non-inverted range.

Scope limit worth knowing: a platform closure blocks every doctor's calendar; a
facility closure is stored, audited and listed but blocks no calendar yet,
because `AvailabilitySlot` carries no facility (one calendar per doctor, PRD
§8.6). That is a single predicate in `availability/services/closures.ts` when
multi-facility doctors land.
