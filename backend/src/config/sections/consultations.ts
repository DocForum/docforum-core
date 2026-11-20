import { positiveNumber } from '../helpers';

/** Consultation thread signing key. The signed download URL is an HMAC over
 * (attachment id, expiry), so a leaked URL stops working when it expires and
 * cannot be minted by a client. In production this must be set explicitly —
 * an implicit shared key would let anyone who reads this file mint URLs. */
function parseAttachmentUrlSecret(raw: string | undefined, isProduction: boolean): string {
  if (raw && raw !== '') return raw;
  if (isProduction) {
    throw new Error('Missing required env var: CONSULTATION_ATTACHMENT_URL_SECRET');
  }
  return 'dev-only-consultation-attachment-url-secret';
}

// Phase 2, issues #61–#64 (async consultation thread, attachments, follow-up
// requests, note sign-off). All v1 defaults, not tuned values.
export const consultations = {
  // A thread stops accepting new messages this long after the consultation
  // was closed (Consultation.createdAt — the record is created when the visit
  // is closed, so it is the completion anchor until Appointment.completedAt
  // exists).
  threadCloseAfterDays: positiveNumber(process.env.CONSULTATION_THREAD_CLOSE_AFTER_DAYS, 7),
  // Notes stay editable this long after close, then the sweep signs them off.
  autoSignOffHours: positiveNumber(process.env.CONSULTATION_AUTO_SIGN_OFF_HOURS, 24),
  signOffSweepIntervalSeconds: positiveNumber(process.env.CONSULTATION_SIGN_OFF_SWEEP_INTERVAL_SECONDS, 60 * 60),
  // Follow-up window offered when the doctor does not name one.
  followUpWindowDays: positiveNumber(process.env.CONSULTATION_FOLLOW_UP_WINDOW_DAYS, 14),
  followUpExpirySweepIntervalSeconds: positiveNumber(
    process.env.CONSULTATION_FOLLOW_UP_SWEEP_INTERVAL_SECONDS,
    60 * 60,
  ),
  // Attachments (issue #62).
  attachmentMaxBytes: positiveNumber(process.env.CONSULTATION_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024),
  attachmentMaxPerMessage: positiveNumber(process.env.CONSULTATION_ATTACHMENT_MAX_PER_MESSAGE, 5),
  attachmentQuotaBytes: positiveNumber(process.env.CONSULTATION_ATTACHMENT_QUOTA_BYTES, 50 * 1024 * 1024),
  attachmentUrlTtlSeconds: positiveNumber(process.env.CONSULTATION_ATTACHMENT_URL_TTL_SECONDS, 5 * 60),
  attachmentUrlSecret: parseAttachmentUrlSecret(
    process.env.CONSULTATION_ATTACHMENT_URL_SECRET,
    process.env.NODE_ENV === 'production',
  ),
} as const;
