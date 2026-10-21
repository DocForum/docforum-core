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
  // Stroops (native XLM's smallest unit), matching
  // @docforum/escrow-sdk's bigint amount exactly. Sent as a string over
  // JSON (a raw number can't safely carry bigint precision) and parsed
  // here.
  amountStroops: z
    .string()
    .regex(/^[1-9][0-9]*$/, 'amountStroops must be a positive integer string.')
    .transform((value) => BigInt(value)),
});

const isoDateString = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value), {
    message: 'must be an ISO-8601 date or date-time',
  });

const isoDate = isoDateString.transform((value) => new Date(value));

const inclusiveEndDate = isoDateString.transform((value) => {
  const date = new Date(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCHours(23, 59, 59, 999);
  return date;
});

export const paymentHistoryQuerySchema = z
  .object({
    status: z.enum(['created', 'escrowed', 'released', 'refunded', 'failed']).optional(),
    from: isoDate.optional(),
    to: inclusiveEndDate.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '`from` must not be after `to`.',
  });
