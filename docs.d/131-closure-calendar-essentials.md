---
file: ARCHITECTURE_ESSENTIALS.md
after: "`AvailabilitySlot` (doctor's calendar)"
---
`ClosurePeriod` (Phase 2, issue #131 — admin-managed closure calendar; `scope platform|facility`, inclusive all-day range + the IANA `timeZone` it is read in). Creating one removes the still-open slots in its window via one conditional DELETE and *reports* booked appointments; it never cancels them. Slot generation skips it. A `platform` closure blocks every doctor's calendar; a `facility` closure is stored and listed but blocks none yet (no `AvailabilitySlot` → facility link).
