Phase 8: normalise email case at signup, login, invite and password reset ([issue #268](https://github.com/DocForum/docforum-core/issues/268)).
Trim and lowercase email addresses across all auth endpoints and add database functional unique index on `LOWER("email")` to guarantee case-insensitive uniqueness. Include operator preflight check script for case collisions before migration.
