import { z } from 'zod';

export const linkWalletSchema = z.object({
  // Stellar public keys are 56 chars, start with 'G'. Not a full
  // checksum validation (that's what create_escrow/the network itself
  // will reject) — just a sanity bound against obvious garbage input.
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
  // Asset code, matched against the environment's allowlist in the
  // service (issue #79). Defaults to XLM so pre-#79 clients that only
  // rename `amountStroops` keep working.
  assetCode: z
    .string()
    .regex(/^[A-Z0-9]{1,12}$/, 'assetCode must be 1-12 uppercase alphanumeric characters.')
    .default('XLM'),
  // Smallest unit of `assetCode` (stroops for XLM, 7-decimal units for
  // USDC), matching @docforum/escrow-sdk's bigint amount exactly. Sent as a
  // string over JSON (a raw number can't safely carry bigint precision)
  // and parsed here. The server never scales it, so it never assumes a
  // particular asset's decimals.
  amount: z
    .string()
    .regex(/^[1-9][0-9]*$/, 'amount must be a positive integer string.')
    .transform((value) => BigInt(value)),
});
