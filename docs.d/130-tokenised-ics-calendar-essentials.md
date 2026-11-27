---
file: ARCHITECTURE_ESSENTIALS.md
section: Data model map (see ARCHITECTURE.md §4 for full field lists)
---
`DoctorProfile` → `DoctorCalendarFeed` (1:1; hashed bearer token, returned
only on issue or rotation); `Appointment` retains latest slot start/end for
cancellation events in its PHI-free doctor calendar feed.
