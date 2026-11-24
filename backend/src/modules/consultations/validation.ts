import { z } from 'zod';
import { referralTargetSchema } from '../referrals/validation';

const isoDateTime = z.string().datetime({ offset: true });

const followUpWindowShape = {
  followUpWindowStart: isoDateTime.optional(),
  followUpWindowEnd: isoDateTime.optional(),
};

function checkWindow(
  value: { followUpWindowStart?: string; followUpWindowEnd?: string },
  ctx: z.RefinementCtx,
) {
  if (!value.followUpWindowStart !== !value.followUpWindowEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'followUpWindowStart and followUpWindowEnd must be supplied together.',
    });
  }
  if (value.followUpWindowStart && value.followUpWindowEnd) {
    if (new Date(value.followUpWindowEnd) <= new Date(value.followUpWindowStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'followUpWindowEnd must be after followUpWindowStart.',
      });
    }
  }
}

/** Close route: the outcome is the point of closing, so it is required, and
 * notes are the clinical record itself (empty notes are not a record). */
export const closeConsultationSchema = z
  .object({
    outcome: z.enum(['resolved', 'referred', 'follow_up_needed']),
    notes: z.string().min(1).max(20000).optional(),
    ...followUpWindowShape,
  })
  .superRefine(checkWindow);

/** Create route (Phase 3's slice): the same row, addressable before sign-off. */
export const createConsultationSchema = z
  .object({
    appointmentId: z.string().min(1),
    outcome: z.enum(['resolved', 'referred', 'follow_up_needed']).optional(),
    notes: z.string().trim().min(1).optional(),
    ...followUpWindowShape,
  })
  .superRefine(checkWindow);

export const createReferralsSchema = z.object({
  targets: z.array(referralTargetSchema).min(1),
});

export const listConsultationsQuerySchema = z.object({
  patientProfileId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

// --- Issue #61/#62: messages and attachments ----------------------------

const attachmentSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  // Size/type/quota checks belong to the service (it needs the decoded bytes).
  dataBase64: z.string().min(1),
});

export const postMessageSchema = z
  .object({
    body: z.string().max(20000).optional(),
    attachments: z.array(attachmentSchema).max(5).optional(),
  })
  .refine((value) => (value.body ?? '').trim().length > 0 || (value.attachments?.length ?? 0) > 0, {
    message: 'A message needs text or at least one attachment.',
  });

export const listMessagesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// --- Issue #64: note editing, sign-off, addenda -------------------------

export const updateNotesSchema = z.object({
  notes: z.string().trim().min(1).max(20000),
});

export const addAddendumSchema = z.object({
  body: z.string().trim().min(1).max(20000),
});

// --- Issue #63: follow-up requests -------------------------------------

export const listFollowUpsQuerySchema = z.object({
  status: z.enum(['open', 'booked', 'expired']).optional(),
});

export const bookFollowUpSchema = z.object({
  availabilitySlotId: z.string().min(1),
});
