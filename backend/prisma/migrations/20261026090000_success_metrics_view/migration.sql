-- Aggregate inputs for the admin success-metrics endpoint (issue #124).
-- A plain view keeps reads current and does not require a refresh job or
-- lock tables used by the booking path.
CREATE VIEW "SuccessMetricAppointment" AS
SELECT
  appointment."status"::text AS "status",
  appointment."createdAt" AS "bookedAt",
  slot."startTime" AS "appointmentAt"
FROM "Appointment" AS appointment
JOIN "AvailabilitySlot" AS slot
  ON slot."id" = appointment."availabilitySlotId";
