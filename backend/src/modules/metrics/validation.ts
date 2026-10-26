import { z } from 'zod';

const utcInstant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const metricsQuerySchema = z.object({
  from: utcInstant,
  to: utcInstant,
}).refine(({ from, to }) => from < to, {
  message: '`from` must be before `to`.',
  path: ['to'],
}).refine(({ from, to }) => to.getTime() - from.getTime() <= 366 * 24 * 60 * 60 * 1000, {
  message: 'The requested range cannot exceed 366 days.',
  path: ['to'],
});
