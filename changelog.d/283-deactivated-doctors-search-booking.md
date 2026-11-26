Deactivated/deleted doctors excluded from search, slot listing, and all booking paths (issue #283).

Added `doctorsService.assertDoctorActive()` checking both `User.deactivatedAt` and `User.deletedAt`, called from:
- `availability/services.listOpenSlots` — throws 409 if doctor is deactivated/deleted
- `availability/services.getNextAvailableSlots` — filters out deactivated/deleted doctors at DB level
- `availability/services.getDoctorIdsWithAvailableSlotsBefore` — filters out deactivated/deleted doctors at DB level
- `appointments/services.bookSlot` — throws 409 before claiming slot
- `appointments/services.rescheduleSlot` — throws 409 before claiming new slot
- `appointments/services.bookForReferral` — throws 409 before creating appointment
- `appointments/services.bookForFollowUp` — throws 409 before creating appointment
- `referrals/services.acceptReferral` — throws 409 before updating referral status

Existing scheduled appointments for deactivated doctors are NOT auto-cancelled; only new bookings are blocked.