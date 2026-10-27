import { z } from 'zod';

const utcInstant = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const metricsQuerySchema = z.object({
  from: utcInstant,
  to: utcInstant,
}).superRefine(({ from, to }, context) => {
  // A failed string datetime check can leave the untransformed string in
  // the object while object-level refinements still run. Defer date checks
  // to the field errors in that case instead of calling Date methods on it.
  if (!(from instanceof Date) || !(to instanceof Date)) return;

  const fromTime = from.getTime();
  const toTime = to.getTime();
  if (Number.isNaN(fromTime) || Number.isNaN(toTime)) return;

  if (fromTime >= toTime) {
    context.addIssue({
      code: 'custom',
      message: '`from` must be before `to`.',
      path: ['to'],
    });
  }
  if (toTime - fromTime > 366 * 24 * 60 * 60 * 1000) {
    context.addIssue({
      code: 'custom',
      message: 'The requested range cannot exceed 366 days.',
      path: ['to'],
    });
  }
});
