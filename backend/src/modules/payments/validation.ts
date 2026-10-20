import { z } from 'zod';

export const linkWalletSchema = z.object({
  // Stellar public keys are 56 chars, start with 'G'. Not a full
  // checksum validation (that's what create_escrow/the network itself
  // will reject) — just a sanity bound against obvious garbage input.
  stellarPublicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'stellarPublicKey must be a valid Stellar public key (starts with G, 56 chars).'),
});
