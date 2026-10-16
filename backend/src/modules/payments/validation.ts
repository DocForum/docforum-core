import { z } from 'zod';

export const linkWalletSchema = z.object({
  // Stellar public keys are 56 chars, start with 'G'. Not a full
  // checksum validation (that's what create_escrow/the network itself
  // will reject) — just a sanity bound against obvious garbage input.
  // (The SEP-10 challenge endpoint DOES checksum-validate via
  // StrKey.isValidEd25519PublicKey — see services/sep10.ts.)
  stellarPublicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'stellarPublicKey must be a valid Stellar public key (starts with G, 56 chars).'),
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
