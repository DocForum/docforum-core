Phase 8, issue #336: Complete the patient data export with consultations, referrals and disputes

New export sections registered in `src/export-sections.ts` so a right-of-access export
is complete:

- `waitlistExportSection` (appointments module): paged waitlist entries with doctor profile ID,
  specialty, acceptance window, and status.
- `referralsExportSection` (referrals module): referral records with snapshot notes, lineage
  (target doctor/specialty), no-show count, and expiry information.
- `orderDisputesExportSection` (orders module): order dispute records with reason, confirmation
  and resolution timestamps, and resolution notes.

Each section is registered in `PATIENT_EXPORT_SECTIONS` and contributes its data through its
module's service, following the established pattern where each module owns and exports its own
section from its services.

Closes #336