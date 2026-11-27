CREATE TABLE "DoctorCalendarFeed" (
    "doctorProfileId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorCalendarFeed_pkey" PRIMARY KEY ("doctorProfileId")
);

CREATE UNIQUE INDEX "DoctorCalendarFeed_tokenHash_key"
ON "DoctorCalendarFeed"("tokenHash");

ALTER TABLE "DoctorCalendarFeed"
ADD CONSTRAINT "DoctorCalendarFeed_doctorProfileId_fkey"
FOREIGN KEY ("doctorProfileId") REFERENCES "DoctorProfile"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Appointment"
ADD COLUMN "calendarStartTime" TIMESTAMP(3),
ADD COLUMN "calendarEndTime" TIMESTAMP(3);

UPDATE "Appointment" AS appointment
SET "calendarStartTime" = slot."startTime",
    "calendarEndTime" = slot."endTime"
FROM "AvailabilitySlot" AS slot
WHERE appointment."availabilitySlotId" = slot."id";

ALTER TABLE "Appointment"
ADD CONSTRAINT "Appointment_calendar_times_pair_check"
CHECK (("calendarStartTime" IS NULL) = ("calendarEndTime" IS NULL)),
ADD CONSTRAINT "Appointment_calendar_times_order_check"
CHECK ("calendarStartTime" IS NULL OR "calendarEndTime" > "calendarStartTime");

CREATE INDEX "Appointment_doctorProfileId_status_calendarStartTime_idx"
ON "Appointment"("doctorProfileId", "status", "calendarStartTime");
