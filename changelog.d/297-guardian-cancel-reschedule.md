---
type: changed
issue: 297
---
Authorised appointment cancellation (both `POST /appointments/:id/cancel` and `PATCH /appointments/:appointmentId/cancel`) and rescheduling (`POST /appointments/:id/reschedule`) for guardians of dependent minors via `patientsService.resolveActingProfile`, recording the guardian as the actor and the dependent's profile in audit metadata.
