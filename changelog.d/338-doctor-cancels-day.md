Phase 2, issue #338: Doctor cancels a whole day of appointments (sick day)

Added `POST /appointments/doctor/cancel-day` endpoint that takes a date (in the
doctor's time zone) and an optional reason. The endpoint:

- Finds all `scheduled` appointments for the doctor on that calendar day
- Runs `applyScheduledTransition` for each, so referral cascades fire
- Closes open slots for appointments that released their slots (conditional on
  the cutoff window), so those slots become bookable again
- Returns `{ cancelled, slots_closed, failures, appointment_ids }`

This saves doctors from cancelling each appointment individually and prevents
new bookings from landing on a day the doctor will not work.

Changes made:
- `backend/src/modules/appointments/services/index.ts`: Added `cancelDay` service
  method that iterates the doctor's scheduled appointments for the day, calls
  `applyScheduledTransition` per appointment (ensuring referral cascades), and
  conditionally releases slots.
- `backend/src/modules/appointments/controllers/index.ts`: Added `cancelDay`
  HTTP handler that extracts the `date` query parameter, validates auth, and
  returns the cancellation summary.
- `backend/src/modules/appointments/routes/index.ts`: Registered
  `POST /appointments/doctor/cancel-day` with doctor authentication and verified
  email requirement.
- `changelog.d/338-doctor-cancels-day.md`: This fragment.

Closes #338