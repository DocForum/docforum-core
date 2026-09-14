// payments services — placeholder.
//
// This module owns PaymentIntent/WalletLink (relational metadata only —
// no PHI ever passes through here) and delegates actual escrow contract
// calls to the @docforum/escrow-sdk package published from the sibling
// docforum-escrow repo. This module does NOT reimplement contract logic —
// it calls the SDK, persists the resulting tx hash/status, and exposes
// that status to other core modules (e.g. facilities) through this
// services/ interface, per AGENTS.md module-boundary rule.
//
// TODO(Phase: see ROADMAP.md payments phase): implement once
// @docforum/escrow-sdk is published (see docforum-escrow repo).
export {};
