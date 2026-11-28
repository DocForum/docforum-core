---
file: ARCHITECTURE_ESSENTIALS.md
section: Known unresolved design gaps (do not silently "fix" without flagging in PR description)
---
- **A facility-scoped closure blocks no doctor's calendar (issue #131).** `ClosurePeriod` supports `scope: 'facility'` and the admin CRUD/list endpoints work, but `AvailabilitySlot` has no facility (one calendar per doctor — the multi-facility deferral below), so there is no slot to attribute to the facility. Platform-wide closures do block generation and remove open slots. Applying facility closures is the one predicate `applicableClosureWindows` in `availability/services/closures.ts`; it should flip when `AvailabilitySlot` gains its facility FK, not before.
