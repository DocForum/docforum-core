import type { Request, Response } from 'express';
import * as consultationsService from '../services';
import {
  addAddendumSchema,
  bookFollowUpSchema,
  closeConsultationSchema,
  createConsultationSchema,
  createReferralsSchema,
  getConsultationQuerySchema,
  listConsultationsQuerySchema,
  listFollowUpsQuerySchema,
  listMessagesQuerySchema,
  postMessageSchema,
  updateNotesSchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';

/** POST /appointments/:appointmentId/consultation — close (create) the
 * consultation for the appointment in the path. */
export async function closeConsultation(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const { outcome, notes, followUpWindowStart, followUpWindowEnd } = closeConsultationSchema.parse(req.body);

  const { consultation, appointment } = await consultationsService.createConsultation(auditActor(req), {
    appointmentId,
    outcome,
    notes,
    followUpWindowStart: followUpWindowStart ? new Date(followUpWindowStart) : undefined,
    followUpWindowEnd: followUpWindowEnd ? new Date(followUpWindowEnd) : undefined,
  });

  res.status(201).json({ consultation, appointment });
}

/** POST /consultations — the same write, with the appointment in the body.
 * Kept because Phase 3's referral flow and its tests address it this way. */
export async function create(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const input = createConsultationSchema.parse(req.body);
  const { consultation } = await consultationsService.createConsultation(auditActor(req), {
    ...input,
    followUpWindowStart: input.followUpWindowStart ? new Date(input.followUpWindowStart) : undefined,
    followUpWindowEnd: input.followUpWindowEnd ? new Date(input.followUpWindowEnd) : undefined,
  });
  res.status(201).json(consultation);
}

export async function getOne(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { patientProfileId } = getConsultationQuerySchema.parse(req.query);
  const consultation = await consultationsService.getConsultation(
    req.user.id,
    getParam(req, 'consultationId'),
    patientProfileId,
  );
  res.status(200).json(consultation);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const query = listConsultationsQuerySchema.parse(req.query);
  const result = await consultationsService.listMyConsultations(req.user.id, query);
  res.status(200).json(result);
}

export async function listDoctor(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const query = listConsultationsQuerySchema.parse(req.query);
  const result = await consultationsService.listDoctorConsultations(req.user.id, query);
  res.status(200).json(result);
}

// --- Issue #61/#62: thread -------------------------------------------------

export async function listMessages(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const query = listMessagesQuerySchema.parse(req.query);
  const result = await consultationsService.listMessages(req.user.id, getParam(req, 'consultationId'), query);
  res.status(200).json(result);
}

export async function postMessage(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const input = postMessageSchema.parse(req.body);
  const message = await consultationsService.postMessage(
    auditActor(req),
    getParam(req, 'consultationId'),
    input,
  );
  res.status(201).json(message);
}

export async function attachmentDownloadUrl(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const baseUrl = `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  const result = await consultationsService.authorizeAttachmentDownload(
    req.user.id,
    getParam(req, 'attachmentId'),
    (attachmentId) => consultationsService.createDownloadLink(attachmentId, baseUrl),
  );
  res.status(200).json(result.link);
}

/** The signed endpoint. No authenticate middleware: possession of an
 * unexpired signature is the authorisation, by design. */
export async function downloadAttachmentFile(req: Request, res: Response) {
  const expires = Number(req.query.expires);
  const signature = String(req.query.signature ?? '');
  const { attachment, object } = await consultationsService.readSignedAttachment(
    getParam(req, 'attachmentId'),
    expires,
    signature,
  );

  res.setHeader('Content-Type', attachment.contentType);
  res.setHeader('Content-Length', String(object.body.length));
  res.setHeader('Content-Disposition', `attachment; filename="${attachment.fileName.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(object.body);
}

// --- Issue #64: notes, sign-off, addenda -----------------------------------

export async function updateNotes(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { notes } = updateNotesSchema.parse(req.body);
  const consultation = await consultationsService.updateNotes(
    auditActor(req),
    getParam(req, 'consultationId'),
    notes,
  );
  res.status(200).json(consultation);
}

export async function signOff(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const consultation = await consultationsService.signOff(auditActor(req), getParam(req, 'consultationId'));
  res.status(200).json(consultation);
}

export async function addAddendum(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { body } = addAddendumSchema.parse(req.body);
  const consultation = await consultationsService.addAddendum(
    auditActor(req),
    getParam(req, 'consultationId'),
    body,
  );
  res.status(201).json(consultation);
}

// --- Issue #63: follow-up requests -----------------------------------------

export async function listMyFollowUps(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { status } = listFollowUpsQuerySchema.parse(req.query);
  const followUps = await consultationsService.listMyFollowUps(req.user.id, status);
  res.status(200).json(followUps);
}

export async function bookFollowUp(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { availabilitySlotId } = bookFollowUpSchema.parse(req.body);
  const result = await consultationsService.bookFollowUp(
    auditActor(req),
    getParam(req, 'followUpId'),
    availabilitySlotId,
  );
  res.status(201).json(result);
}

export async function createReferrals(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { targets } = createReferralsSchema.parse(req.body);
  const referrals = await consultationsService.createReferrals(
    req.user.id,
    getParam(req, 'consultationId'),
    targets,
  );
  res.status(201).json(referrals);
}
