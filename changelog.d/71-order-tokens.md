Phase 4: Verifiable order tokens: QR codes a facility can check against the backend
(issue #71, PRD §8.1.6).

Added `OrderToken` model with HMAC-SHA256 opaque token (no PHI encoded),
version for revocation when order is superseded. Automatic token issuance on
prescription/lab order creation via `order-tokens` service. `POST
/facilities/me/verify-order` endpoint takes a token and returns order summary +
status only if the facility is eligible (capability match). Superseded,
expired, or fulfilled orders return clear non-valid status. Rate-limiting on
verification endpoint prevents enumeration. Integration tests in
`backend/tests/integration/order-tokens.test.mts`.