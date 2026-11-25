---
file: ARCHITECTURE_ESSENTIALS.md
section: Escrow event monitoring (issue #86)
---
- Operator actions for both cases are in [docs/runbooks/escrow-event-alerts.md](docs/runbooks/escrow-event-alerts.md) (issue #356): reading the endpoint, triaging an unmatched release or refund, pausing wallet funding, and recovering from a retention gap. The runbook also lists the controls that do not exist yet (no acknowledgement workflow, no dead-letter requeue, no switch for already-escrowed settlements).
