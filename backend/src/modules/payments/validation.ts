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

export const createPaymentIntentSchema = z.object({
  orderType: z.enum(['prescription', 'lab_order']),
  // Opaque — see schema.prisma comment. Not validated against a real
  // Prescription/LabOrder record yet (Phase 4 doesn't exist).
  orderId: z.string().min(1),
  patientProfileId: z.string().min(1),
  facilityId: z.string().min(1),
  // Stroops (native XLM's smallest unit), matching
  // @docforum/escrow-sdk's bigint amount exactly. Sent as a string over
  // JSON (a raw number can't safely carry bigint precision) and parsed
  // here.
  amountStroops: z
    .string()
    .regex(/^[1-9][0-9]*$/, 'amountStroops must be a positive integer string.')
    .transform((value) => BigInt(value)),
});

// SEP-10 (issue #77). Shape-only gate: the checksum-accurate strkey
// validation (and the 400) happens in services/sep10.ts via
// StrKey.isValidEd25519PublicKey, so the service layer is safe for
// non-HTTP callers too.
export const sep10ChallengeQuerySchema = z.object({
  account: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'account must be a valid Stellar public key (starts with G, 56 chars).'),
});

export const sep10VerifySchema = z.object({
  // base64 TransactionEnvelope XDR of the wallet-signed challenge.
  transaction: z.string().min(1),
});
