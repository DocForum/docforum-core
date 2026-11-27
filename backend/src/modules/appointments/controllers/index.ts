import type { Request, Response } from 'express';

import * as appointmentsService from '../services';
import * as patientsService from '../../patients/services';
import {
  cancelDaySchema,
  acceptWaitlistSchema,
  bookSlotSchema,
  doctorScheduleQuerySchema,
  leaveWaitlistSchema,
  listMineQuerySchema,
  rescheduleSlotBodySchema,
  updateStatusSchema,
  waitlistJoinSchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { setVersionEtag } from '../../../middleware/optimistic-concurrency';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';
import { createHash } from 'node:crypto';
import { config } from '../../../config';
import { serializeCalendarFeed } from '../calendar-ics';

export async function book(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { availabilitySlotId, patientProfileId } = bookSlotSchema.parse(req.body);
  const appointment = await appointmentsService.bookSlot(auditActor(req), availabilitySlotId, patientProfileId);
  res.status(201).json(appointment);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { patientProfileId } = listMineQuerySchema.parse(req.query);
  const appointments = await appointmentsService.listMyAppointments(req.user.id, patientProfileId);
  res.status(200).json(appointments);
}

export async function reschedule(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { newSlotId } = rescheduleSlotBodySchema.parse(req.body);
  const appointmentId = req.params.id as string;
  const appointment = await appointmentsService.rescheduleSlot(auditActor(req), appointmentId, newSlotId);
  res.status(200).json(appointment);
}

export async function cancel(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointmentId = req.params.id as string;
  const appointment = await appointmentsService.cancelAppointment(auditActor(req), appointmentId);
  res.status(200).json(appointment);
}

export async function joinWaitlist(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { doctorProfileId, specialtyId, earliestAcceptable, latestAcceptable, holdDurationMinutes } = waitlistJoinSchema.parse(req.body);
  // Convert datetime strings to Date objects (or use defaults)
  const earliest = earliestAcceptable ? new Date(earliestAcceptable) : undefined;
  const latest = latestAcceptable ? new Date(latestAcceptable) : undefined;
  const patientProfile = await patientsService.getMyPatientProfile(req.user.id);
  const entry = await appointmentsService.joinWaitlist(auditActor(req), patientProfile.id, doctorProfileId, specialtyId, earliest, latest, holdDurationMinutes);
  res.status(201).json(entry);
}

export async function leaveWaitlist(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { entryId: entryIdParam } = leaveWaitlistSchema.parse(req.body);
  // Try to get entryId from params if not in body
  const entryId = entryIdParam || (req.params.id as string);
  if (!entryId) {
    throw new HttpError('INVALID_REQUEST', 'entryId is required.');
  }
  const result = await appointmentsService.leaveWaitlist(auditActor(req), entryId);
  res.status(200).json(result);
}

export async function listWaitlist(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(req.user.id);
  const entries = await appointmentsService.listWaitlistEntries(patientProfile.id);
  res.status(200).json(entries);
}

export async function acceptWaitlistOffer(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { entryId } = acceptWaitlistSchema.parse(req.body);
  const appointment = await appointmentsService.acceptWaitlistOffer(auditActor(req), entryId);
  res.status(201).json(appointment);
}

export async function listDoctorToday(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointments = await appointmentsService.listDoctorAppointmentsToday(req.user.id);
  res.status(200).json(appointments);
}

export async function listDoctorSchedule(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const query = doctorScheduleQuerySchema.parse(req.query);
  const appointments = await appointmentsService.listDoctorSchedule(req.user.id, query);
  res.status(200).json(appointments);
}

export async function updateStatus(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { status } = updateStatusSchema.parse(req.body);
  const appointment = await appointmentsService.updateStatusByDoctor(
    auditActor(req),
    getParam(req, 'appointmentId'),
    status,
  );
  res.status(200).json(appointment);
}

export async function cancelMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointment = await appointmentsService.cancelByPatient(
    auditActor(req),
    getParam(req, 'appointmentId'),
  );
  res.status(200).json(appointment);
}

/** `POST /appointments/doctor/cancel-day` — the caller (a doctor) cancels
 * the rest of one day in their own time zone (issue #338). */
export async function cancelDay(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const { date, reason } = cancelDaySchema.parse(req.body);
  res.status(200).json(await appointmentsService.cancelDay(auditActor(req), date, reason));
}

export async function getOne(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointmentId = getParam(req, 'id');
  const appointment = await appointmentsService.getAppointmentDetail(req.user.id, appointmentId);
  setVersionEtag(res, appointment.version);
  res.status(200).json(appointment);
}

export async function checkIn(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const appointment = await appointmentsService.getAppointmentDetail(req.user.id, appointmentId);
  res.status(200).json(appointment);
}

export async function getQueue(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const appointment = await appointmentsService.getAppointmentDetail(req.user.id, appointmentId);
  res.status(200).json({ appointmentId, appointment });
}

export async function calendarFeed(req: Request, res: Response) {
  const token = getParam(req, 'token');
  const events = await appointmentsService.getCalendarFeedEvents(token);
  const body = serializeCalendarFeed(events, config.appBaseUrl);
  const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
  const lastModified = events.reduce(
    (latest, event) => (event.updatedAt > latest ? event.updatedAt : latest),
    new Date(0),
  );

  res.set({
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Type': 'text/calendar; charset=utf-8',
    ETag: etag,
    'Last-Modified': lastModified.toUTCString(),
  });
  if (req.fresh) return res.status(304).end();
  return res.status(200).send(body);
}
