Phase 5.5: automatic escrow settlement — release on confirmed fulfillment
(issue #83) and refund on rejection or expiry (issue #84). The order
transition writes `order.fulfilled` / `order.rejected` / `order.expired` in
its own transaction; the existing transactional-outbox worker (issue #94,
verified still in place) claims it with `FOR UPDATE SKIP LOCKED`, retries with
bounded backoff, and its lease recovers a killed worker without losing or
duplicating the task. Release requires a whole order to derive `fulfilled`
(partial fulfillment never releases); rejection refunds only when nothing was
dispensed and no record is still open; lab-order expiry refunds inside the
expiry update. Intent updates are conditional, so release and a timeout refund
cannot both commit locally, and an on-chain `NotFunded` is a terminal `failed`
reconcile with an audit row rather than a retry loop. Refund completion
notifies the patient in-app. The admin `release`/`refund` endpoints stay as
audited manual overrides.

Phase 4: abnormal lab result escalation and doctor acknowledgement
(issue #72, PRD §8.2.7). `LabResult.abnormality` is set by the facility at
attach time; abnormal/critical results open one acknowledgement task for the
ordering doctor (same transaction), notify them, and escalate to the admin
queue after `LAB_RESULT_ESCALATION_HOURS` (default 24). New endpoints
`POST /lab-results/:id/acknowledge` and `GET /lab-results/unacknowledged`;
acknowledgement and escalation are one-shot conditional writes with audit
events, and `overdue` is derived from the deadline so a missed job tick is
visible. Migration adds the enum, the `LabResult` column and the
`LabResultAcknowledgement` table. Critical results are **not** withheld from
the patient.
