---
type: added
issue: 296
---
Added role-scoped `GET /appointments/:id` detail endpoint with strong ETag, slot times, and doctor summary, accessible only by the patient, guardian, or treating doctor (non-participants and admins receive 404). Replaced list-and-find pattern in appointment check-in and queue controllers.
