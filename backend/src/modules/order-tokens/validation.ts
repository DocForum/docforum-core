import { z } from 'zod';

export const verifyOrderTokenSchema = z.object({
  token: z.string().min(1).max(500),
});

export const issueOrderTokenSchema = z.object({
  orderType: z.enum(['prescription', 'lab_order']),
  orderId: z.string().uuid(),
});