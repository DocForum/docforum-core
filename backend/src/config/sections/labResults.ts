import { positiveNumber } from '../helpers';

export const labResults = {
  maxBytes: positiveNumber(process.env.LAB_RESULT_MAX_BYTES, 10 * 1024 * 1024),
} as const;
