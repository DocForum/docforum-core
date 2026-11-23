---
file: ARCHITECTURE.md
section: 6. Hard questions (architecture-level — see PRD §8 for product-level) > 6.2 What edge cases are we missing (architecture-level)?
---
7. **Discovered 2026-11-23 (issue #334):** the error handler now maps Prisma `P2025`/`P2003` to 404/422, but a Postgres `ON DELETE RESTRICT` refusal (SQLSTATE 23001) reaches Prisma as an *unknown* request error with no code, so a route that deletes a still-referenced row without catching it (as `isForeignKeyRefusal` does for account deletion) still answers 500. Mapping it generically would mean matching on driver error text; left to explicit call-site checks for now.
