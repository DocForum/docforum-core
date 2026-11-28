import type { Request, Response } from 'express';
import * as availabilityService from '../services';
import {
  createClosurePeriodSchema,
  generateSlotsSchema,
  listClosurePeriodsQuerySchema,
  listSlotsQuerySchema,
  updateClosurePeriodSchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { auditActor } from '../../../middleware/request-id';
import { expectedVersion, setVersionEtag } from '../../../middleware/optimistic-concurrency';
import { calendarDateString } from '../closure-periods';

export async function listSlots(req: Request, res: Response) {
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const query = listSlotsQuerySchema.parse(req.query);
  const slots = await availabilityService.listOpenSlots(doctorProfileId, query);
  res.status(200).json(slots);
}

export async function generateSlots(req: Request, res: Response) {
  if (!req.user) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const doctorProfileId = getParam(req, 'doctorProfileId');
  const doctor = await availabilityService.assertCanGenerateFor(req.user.id, doctorProfileId);

  const input = generateSlotsSchema.parse(req.body);
  const result = await availabilityService.generateSlots({
    doctorProfileId,
    timeZone: doctor.timeZone,
    ...input,
  });
  res.status(201).json(result);
}

// --- Closure calendar (Phase 2, issue #131) --------------------------------

/** Wire shape: calendar dates as `YYYY-MM-DD` (never an instant — an all-day
 * closure has no time of day), timestamps as ISO strings. */
function serializeClosure(closure: {
  id: string;
  version: number;
  scope: string;
  facilityProfileId: string | null;
  startDate: Date;
  endDate: Date;
  timeZone: string;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: closure.id,
    version: closure.version,
    scope: closure.scope,
    facilityProfileId: closure.facilityProfileId,
    startDate: calendarDateString(closure.startDate),
    endDate: calendarDateString(closure.endDate),
    timeZone: closure.timeZone,
    reason: closure.reason,
    createdAt: closure.createdAt.toISOString(),
    updatedAt: closure.updatedAt.toISOString(),
  };
}

function serializeApplication(application: availabilityService.ClosureApplication) {
  return {
    openSlotsRemoved: application.openSlotsRemoved,
    // Reported for manual handling, never cancelled. Ids and times only.
    affectedBookings: application.affectedBookings.map((booking) => ({
      appointmentId: booking.appointmentId,
      doctorProfileId: booking.doctorProfileId,
      startTime: booking.startTime ? booking.startTime.toISOString() : null,
    })),
    affectedBookingCount: application.affectedBookings.length,
  };
}

/** GET /availability/closures — the closure calendar for clients. Public:
 * a closed day carries no patient data. Defaults to closures not yet ended. */
export async function listClosures(req: Request, res: Response) {
  const query = listClosurePeriodsQuerySchema.parse(req.query);
  const closures = await availabilityService.listClosurePeriodsNow(query);
  res.status(200).json({ closures: closures.map(serializeClosure) });
}

/** GET /availability/admin/closures — every closure unless a range is given. */
export async function listAdminClosures(req: Request, res: Response) {
  const query = listClosurePeriodsQuerySchema.parse(req.query);
  const closures = await availabilityService.listClosurePeriods(query);
  res.status(200).json({ closures: closures.map(serializeClosure) });
}

/** GET /availability/admin/closures/:closureId — also the ETag source for
 * the PATCH below (hard rule 7). */
export async function getClosure(req: Request, res: Response) {
  const closure = await availabilityService.getClosurePeriod(getParam(req, 'closureId'));
  setVersionEtag(res, closure.version);
  res.status(200).json(serializeClosure(closure));
}

/** POST /availability/admin/closures — create and apply in one call. The
 * response reports the slots removed and the bookings left for a human. */
export async function createClosure(req: Request, res: Response) {
  const input = createClosurePeriodSchema.parse(req.body);
  const result = await availabilityService.createClosurePeriod(auditActor(req), input);
  setVersionEtag(res, result.closure.version);
  res.status(201).json({
    closure: serializeClosure(result.closure),
    ...serializeApplication(result),
  });
}

/** PATCH /availability/admin/closures/:closureId — If-Match guarded, then the
 * calendar is re-applied for the (possibly extended) range. */
export async function updateClosure(req: Request, res: Response) {
  const input = updateClosurePeriodSchema.parse(req.body);
  const result = await availabilityService.updateClosurePeriod(
    auditActor(req),
    getParam(req, 'closureId'),
    expectedVersion(req),
    input,
  );
  setVersionEtag(res, result.closure.version);
  res.status(200).json({
    closure: serializeClosure(result.closure),
    ...serializeApplication(result),
  });
}

/** DELETE /availability/admin/closures/:closureId */
export async function deleteClosure(req: Request, res: Response) {
  await availabilityService.deleteClosurePeriod(auditActor(req), getParam(req, 'closureId'));
  res.status(204).send();
}
