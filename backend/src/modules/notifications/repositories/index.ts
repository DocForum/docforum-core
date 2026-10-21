// notifications repositories — placeholder. Data access only. Not to be
// imported by other modules directly — go through services/ instead.
//
// No persistence yet on purpose: the `Notification` model in schema.prisma
// is still the Phase 0 placeholder (no userId column, ARCHITECTURE.md §4.8),
// and the in-app notification feed is Phase 6 — which is blocked on the
// trigger points in Phases 3/4 (ROADMAP.md). Outbound *delivery* (including
// the password reset link, #33) does not need that model, so it goes
// through services/ without a DB row rather than inventing one here.
export {};
