---
file: ARCHITECTURE.md
section: 4.2 Availability & Appointments
---
- AvailabilitySlot overlap prevention (issue #287): PostgreSQL `btree_gist` exclusion constraint `AvailabilitySlot_doctor_no_overlap_excl` on `(doctorProfileId WITH =, tsrange(startTime, endTime) WITH &&)` guarantees that no two open or booked slots for the same doctor can ever overlap, even when generated with mixed slot durations or under concurrent generation calls.
