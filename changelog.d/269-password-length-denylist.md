Phase 8: enforce maximum password length and reject commonly breached passwords ([issue #269](https://github.com/DocForum/docforum-core/issues/269)).
Enforce 72-byte upper bound on password fields to avoid bcrypt truncation and CPU denial-of-service, and reject top commonly breached and guessable passwords using an embedded static denylist.
