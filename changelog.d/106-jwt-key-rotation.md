Phase 9: JWT key rotation with key ids
([issue #106](https://github.com/DocForum/docforum-core/issues/106)).
Access and refresh tokens are signed with the current key and carry its
`kid`. Verification accepts a previous key during an overlap window
(`JWT_*_SECRET_PREVIOUS`), so rotation does not log users out. Tokens with an
unknown `kid` are rejected. The rotation procedure is in
`docs/runbooks/secret-rotation.md`. Loading secrets from a secrets manager and
the staging rotation are still open.
