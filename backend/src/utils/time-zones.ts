import { z } from 'zod';

const supportedTimeZones = new Set(Intl.supportedValuesOf('timeZone'));
supportedTimeZones.add('UTC');

/**
 * Validates that a string is a canonical IANA time zone identifier
 * supported by the runtime, or 'UTC'. Rejects legacy aliases (e.g. 'EST').
 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  return supportedTimeZones.has(timeZone);
}

export const timeZoneSchema = z
  .string()
  .trim()
  .refine((tz) => isValidIanaTimeZone(tz), {
    message: 'Invalid IANA time zone identifier',
  });
