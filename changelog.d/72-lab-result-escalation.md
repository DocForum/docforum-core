Phase 4: Abnormal lab result escalation and doctor acknowledgement tracking
(issue #72, PRD §8.2.7).

Added `LabResult.abnormalityFlag` enum (normal/abnormal/critical) set by
facility when attaching results. `LabResultAcknowledgement` model tracks
acknowledgement status (pending/acknowledged/escalated) with audit trail.
`POST /lab-orders/:id/result` creates acknowledgement task for ordering doctor
when flag is abnormal/critical. `POST /lab-orders/results/:id/acknowledge`
allows doctor to acknowledge. `GET /lab-orders/results/unacknowledged` lists
pending acknowledgements. `escalateUnacknowledgedResults()` cron job
escalates critical results unacknowledged after configurable threshold
(default 24h). Integration tests in
`backend/tests/integration/lab-result-escalation.test.mts`.