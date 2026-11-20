import { z } from 'zod';

/**
 * `GET /medications?q=&limit=` (issue #69).
 *
 * `q` is required: the endpoint is an autocomplete over a controlled
 * vocabulary, not a way to list/dump the catalog. Two-character minimum
 * matches the service's trigram-selectivity rule (and gives a 400 with a
 * clearer message than an empty result set would).
 */
export const searchMedicationsQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
