// Shared across modules — the one place an HTTP-status-bearing error is
// defined, so error-handler.ts has a single shape to check for.

// Machine-readable error codes. Clients branch on these instead of
// string-matching `message`, so messages can change freely. Grouped by
// module; `VALIDATION_FAILED` and `INTERNAL` are cross-cutting.
export enum ErrorCode {
  // Cross-cutting
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INTERNAL = 'INTERNAL',

  // Auth / accounts
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  WALLET_NOT_LINKED = 'WALLET_NOT_LINKED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',

  // Bookings / slots
  SLOT_TAKEN = 'SLOT_TAKEN',
  SLOT_NOT_FOUND = 'SLOT_NOT_FOUND',
  SLOT_DOCTOR_MISMATCH = 'SLOT_DOCTOR_MISMATCH',
  BOOKING_NOT_FOUND = 'BOOKING_NOT_FOUND',
  APPOINTMENT_NOT_FOUND = 'APPOINTMENT_NOT_FOUND',
  APPOINTMENT_NOT_SCHEDULED = 'APPOINTMENT_NOT_SCHEDULED',
  NOT_APPOINTMENT_DOCTOR = 'NOT_APPOINTMENT_DOCTOR',
  NOT_APPOINTMENT_PATIENT = 'NOT_APPOINTMENT_PATIENT',
  DOCTOR_NOT_VERIFIED = 'DOCTOR_NOT_VERIFIED',

  // Orders / payments
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  CONSULTATION_ALREADY_EXISTS = 'CONSULTATION_ALREADY_EXISTS',
  CONSULTATION_NOT_FOUND = 'CONSULTATION_NOT_FOUND ',
  INVALID_PRESCRIPTION_CORRECTION = 'INVALID_PRESCRIPTION_CORRECTION ',
  INVALID_LAB_ORDER_CORRECTION = 'INVALID_LAB_ORDER_CORRECTION',
  ORDER_ALREADY_HAS_CORRECTION_OR_PAYMENT = 'ORDER_ALREADY_HAS_CORRECTION_OR_PAYMENT',

  // Referrals
  REFERRAL_INVALID = 'REFERRAL_INVALID',

  // Generic
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
}

export interface HttpErrorDetails {
  [key: string]: unknown;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // Machine-readable discriminator, for cases where the client has to
    // branch on *why* rather than render the message (e.g. `SLOT_TAKEN`,
    // `EMAIL_NOT_VERIFIED`). Additive: the error envelope keeps its
    // existing `message` field, so docforum-web's api-client parsing is
    // unaffected.
    public readonly code: ErrorCode | string = ErrorCode.INTERNAL,
    // Optional structured context (e.g. Zod field errors for
    // `VALIDATION_FAILED`). Never contains internals for `INTERNAL`.
    public readonly details?: HttpErrorDetails,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
