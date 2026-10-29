import type { Request, Response } from 'express';

import * as appointmentsService from '../services';
import * as patientsService from '../../patients/services';
import {
  acceptWaitlistSchema,
  bookSlotSchema,
  leaveWaitlistSchema,
  listMineQuerySchema,
  rescheduleSlotBodySchema,
  updateStatusSchema,
  waitlistJoinSchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';

export async function book(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { availabilitySlotId, patientProfileId } = bookSlotSchema.parse(req.body);
  const appointment = await appointmentsService.bookSlot(auditActor(req), availabilitySlotId, patientProfileId);
  res.status(201).json(appointment);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { patientProfileId } = listMineQuerySchema.parse(req.query);
  const appointments = await appointmentsService.listMyAppointments(req.user.id, patientProfileId);
  res.status(200).json(appointments);
}

export async function reschedule(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { newSlotId } = rescheduleSlotBodySchema.parse(req.body);
  const appointmentId = req.params.id as string;
  const appointment = await appointmentsService.rescheduleSlot(auditActor(req), appointmentId, newSlotId);
  res.status(200).json(appointment);
}

export async function cancel(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointmentId = req.params.id as string;
  const appointment = await appointmentsService.cancelAppointment(auditActor(req), appointmentId);
  res.status(200).json(appointment);
}

export async function joinWaitlist(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { doctorProfileId, specialtyId, earliestAcceptable, latestAcceptable, holdDurationMinutes } = waitlistJoinSchema.parse(req.body);
  // Convert datetime strings to Date objects (or use defaults)
  const earliest = earliestAcceptable ? new Date(earliestAcceptable) : undefined;
  const latest = latestAcceptable ? new Date(latestAcceptable) : undefined;
  const patientProfile = await patientsService.getMyPatientProfile(req.user.id);
  const entry = await appointmentsService.joinWaitlist(auditActor(req), patientProfile.id, doctorProfileId, specialtyId, earliest, latest, holdDurationMinutes);
  res.status(201).json(entry);
}

export async function leaveWaitlist(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { entryId: entryIdParam } = leaveWaitlistSchema.parse(req.body);
  // Try to get entryId from params if not in body
  const entryId = entryIdParam || (req.params.id as string);
  if (!entryId) {
    throw new HttpError(400, 'entryId is required.');
  }
  const result = await appointmentsService.leaveWaitlist(auditActor(req), entryId);
  res.status(200).json(result);
}

export async function listWaitlist(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(req.user.id);
  const entries = await appointmentsService.listWaitlistEntries(patientProfile.id);
  res.status(200).json(entries);
}

export async function acceptWaitlistOffer(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { entryId } = acceptWaitlistSchema.parse(req.body);
  const appointment = await appointmentsService.acceptWaitlistOffer(auditActor(req), entryId);
  res.status(201).json(appointment);
}

export async function listDoctorToday(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointments = await appointmentsService.listDoctorAppointmentsToday(req.user.id);
  res.status(200).json(appointments);
}

export async function updateStatus(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { status } = updateStatusSchema.parse(req.body);
  const appointment = await appointmentsService.updateStatusByDoctor(
    req.user.id,
    getParam(req, 'appointmentId'),
    status,
  );
  res.status(200).json(appointment);
}

export async function cancelMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointment = await appointmentsService.cancelByPatient(req.user.id, getParam(req, 'appointmentId'));
  res.status(200).json(appointment);
}

export async function checkIn(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const mine = await appointmentsService.listMyAppointments(req.user.id);
  const appointment = mine.find((a: { id: string }) => a.id === appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  res.status(200).json(appointment);
}

export async function getQueue(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointmentId = getParam(req, 'appointmentId');
  const mine = await appointmentsService.listMyAppointments(req.user.id);
  const appointment = mine.find((a: { id: string }) => a.id === appointmentId);
  if (!appointment) throw new HttpError(404, 'Appointment not found.');
  res.status(200).json({ appointmentId, appointment });
}
