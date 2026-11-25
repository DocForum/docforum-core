---
file: ARCHITECTURE.md
section: "2. Tech stack"
---
Notification delivery now has Postmark email and Twilio SMS adapters behind the notifications service boundary. Email and SMS copy is identifier-only and PHI-safe; provider callbacks are signed, delivery outcomes are persisted, SMS consent is stored per normalized E.164 number, and the SMS adapter enforces the configured daily cap.
