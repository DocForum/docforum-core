---
file: ROADMAP.md
section: Phase 8 — Hardening (safety, audit, security)
---
- [x] Guardian read access to a dependent's consultations, referrals and lab results (issue #305): an optional `patientProfileId` on consultation detail, referral list/accept/decline and lab-result download authorises through `patientsService.resolveActingProfile`; ended guardianships get `403 GUARDIANSHIP_INACTIVE`, unrelated profiles `404`, and guardian reads are PHI-access-logged. Existing caller-only behaviour is unchanged. Closes [issue #305](https://github.com/DocForum/docforum-core/issues/305).
