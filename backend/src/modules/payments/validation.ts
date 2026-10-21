import { z } from 'zod';

// Issue #78 — the typed-in address body is GONE. strictObject: a
// client that still sends `stellarPublicKey` (or anything else) is a
// loud 400, never a silently-ignored field, so nobody can believe they
// linked an address the server never saw. The only accepted input is
// the signed SEP-10 challenge; the address comes from verifying it.
export const walletLinkSchema = z.strictObject({
  // base64 TransactionEnvelope XDR of the wallet-signed SEP-10 challenge
  // (issue #77), issued to the authenticated caller for the account
  // being linked.
  transaction: z.string().min(1),
});
