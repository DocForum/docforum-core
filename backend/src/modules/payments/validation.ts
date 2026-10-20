import { z } from 'zod';
import { registerPath } from '../../docs/openapi/registry';

export const linkWalletSchema = z.object({
  // Stellar public keys are 56 chars, start with 'G'. Not a full
  // checksum validation (that's what create_escrow/the network itself
  // will reject) — just a sanity bound against obvious garbage input.
  stellarPublicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'stellarPublicKey must be a valid Stellar public key (starts with G, 56 chars).'),
});

// Response envelope for the wallet-link endpoint. Payment amounts
// are BigInt in the DB, so they are serialised as strings in the
// API contract (see openapi registry BigInt helper).
export const linkWalletResponseSchema = z.object({
  walletId: z.string(),
  stellarPublicKey: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/, 'stellarPublicKey must be a valid Stellar public key (starts with G, 56 chars).'),
  linkedAt: z.string(),
});

export const paymentAmountSchema = z.object({
  amount: z.string().regex(/^[0-9]+$/, 'amount must be a decimal string representing a BigInt'),
  currency: z.string().len(3),
});

registerPath({
  method: 'post',
  path: '/payments/wallet',
  summary: 'Link a Stellar wallet to the authenticated user',
  tags: ['payments'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: linkWalletSchema } },
    },
  },
  responses: {
    200: {
      description: 'Wallet linked',
      content: { 'application/json': { schema: linkWalletResponseSchema } },
    },
    400: { description: 'Validation error', ref: 'ErrorEnvelope' },
    401: { description: 'Unauthenticated', ref: 'ErrorEnvelope' },
  },
});
