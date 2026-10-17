import type { Request, Response } from 'express';
import * as appointmentsService from '../services';
import { bookSlotSchema, updateStatusSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { auditActor } from '../../../middleware/request-id';
import { getParam } from '../../../request-params';

export async function book(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { availabilitySlotId } = bookSlotSchema.parse(req.body);
  const appointment = await appointmentsService.bookSlot(auditActor(req), availabilitySlotId);
  res.status(201).json(appointment);
}

export async function listMine(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const appointments = await appointmentsService.listMyAppointments(req.user.id);
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
