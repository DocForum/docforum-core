---
file: docs/api/README.md
after: "- `GET /availability/doctors/:doctorProfileId/slots`: supports optional"
---
- `POST /availability/doctors/:doctorProfileId/slots/generate` also returns `skippedClosed` — how many slots the generated window would have produced inside a closure (issue #131). `skipped` remains the combined total of `skippedOverlapping` + `skippedClosed`.
