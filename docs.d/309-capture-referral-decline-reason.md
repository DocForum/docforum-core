---
file: ARCHITECTURE.md
after:  cancelled_reason (nullable text)
---
  decline_reason (nullable enum: cost|distance|second_opinion|other — issue #309,
    the optional structured reason a patient gives when declining; null otherwise)
  decline_reason_note (nullable varchar(200) — optional bounded free-text note
    accompanying decline_reason; capped at 200 chars to match the audit metadata
    string limit, §4.10)
