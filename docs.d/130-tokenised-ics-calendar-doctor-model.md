---
file: ARCHITECTURE.md
section: 4.1 User / Role model
---
DoctorCalendarFeed (1:1 DoctorProfile)
  doctor_profile_id (PK, FK -> DoctorProfile), token_hash (unique SHA-256), created_at
  # Raw subscription tokens are returned only when issued or rotated; revocation
  # deletes the row. The bearer token is never stored in plaintext.
