---
type: added
issue: 298
---
Added indexes for unindexed foreign keys and filter columns on `Appointment` (`patientProfileId, createdAt` and `doctorProfileId, status`), `Prescription` (`prescribingDoctorId` and `facilityProfileId`), `LabOrder` (`facilityProfileId`), and `LabResult` (`fulfillingFacilityId`).
