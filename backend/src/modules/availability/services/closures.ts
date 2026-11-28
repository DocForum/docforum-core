// Closure calendar service (Phase 2, issue #131).
//
// An admin-managed closure calendar that blocks slot generation and removes
// already-open slots, at the source. The two properties a reviewer checks:
//   1. removing slots is one conditional DELETE (`status = 'open'`, no
//      appointment attached), never a read-then-write loop;
//   2. a booked appointment inside a new closure is REPORTED, never cancelled
//      — cancellation stays in the appointments/day-cancel flows, where the
//      referral cascade and the audit trail live.
//
// Lives in its own file rather than services/index.ts only to keep the slot
// scheduling code readable; it is re-exported from services/index.ts, so
// callers still import the module's service surface.
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import { prisma } from '../../../db/prisma-client';
import { versionConflict } from '../../../middleware/optimistic-concurrency';
import * as availabilityRepo from '../repositories';
import * as facilitiesService from '../../facilities/services';
import * as auditService from '../../audit/services';
import { closureWindow, calendarDateString, type UtcWindow } from '../closure-periods';
import { assertValidTimeZone } from '../validation';

export type ClosureScopeName = 'platform' | 'facility';

/** Inclusive all-day range, `YYYY-MM-DD`. `timeZone` is the IANA zone the
 * calendar days are read in (defaults to UTC). */
export interface ClosurePeriodInput {
  scope: ClosureScopeName;
  facilityProfileId?: string;
  startDate: string;
  endDate: string;
  timeZone?: string;
  reason: string;
}

export interface ClosurePeriodUpdateInput {
  startDate?: string;
  endDate?: string;
  timeZone?: string;
  reason?: string;
}

export interface ClosureAffectedBooking {
  appointmentId: string;
  doctorProfileId: string;
  startTime: Date | null;
}

export interface ClosureApplication {
  openSlotsRemoved: number;
  affectedBookings: ClosureAffectedBooking[];
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function utcCalendarDay(value: Date): Date {
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function parseCalendarDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * The instant windows a closure blocks on a doctor's calendar.
 *
 * v1: only a platform-wide closure blocks a calendar. A facility-scoped
 * closure cannot yet: `AvailabilitySlot` carries no facility and one doctor
 * owns one calendar (PRD §8.6 / ARCHITECTURE.md §8 — deferred), so there is no
 * slot to attribute to the facility. Returning `[]` is the honest answer and
 * the single place to change when that gap closes; the closure row is still
 * stored, audited and listed, so a clinic's closure calendar is not lost.
 */
function applicableClosureWindows(closure: {
  scope: ClosureScopeName;
  startDate: Date;
  endDate: Date;
  timeZone: string;
}): UtcWindow[] {
  if (closure.scope !== 'platform') return [];
  return [closureWindow(closure)];
}

/**
 * The instant windows that cover `[from, to]` on any doctor's calendar.
 *
 * The stored range is widened by a day on each side before querying: a closure
 * is stored as calendar dates in its own zone, so a slot near midnight UTC can
 * belong to the neighbouring closure date. The exact test is the converted
 * window, never the date comparison.
 */
export async function findApplicableClosureWindows(from: Date, to: Date): Promise<UtcWindow[]> {
  const closures = await availabilityRepo.findClosuresOverlapping(
    new Date(utcCalendarDay(from).getTime() - DAY_MS),
    new Date(utcCalendarDay(to).getTime() + DAY_MS),
  );
  return closures.flatMap((closure) => applicableClosureWindows(closure));
}

function assertClosureRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new HttpError('INVALID_DATE_RANGE', 'endDate must be on or after startDate.');
  }
  const spanDays =
    Math.round((parseCalendarDate(endDate).getTime() - parseCalendarDate(startDate).getTime()) / DAY_MS) + 1;
  if (spanDays > config.availability.slotMaxHorizonDays) {
    throw new HttpError(
      'DATE_RANGE_TOO_LARGE',
      `A closure cannot span more than ${config.availability.slotMaxHorizonDays} days.`,
    );
  }
}

async function assertClosureScope(scope: ClosureScopeName, facilityProfileId?: string): Promise<void> {
  if (scope === 'platform') {
    if (facilityProfileId) throw new HttpError('CLOSURE_SCOPE_CONFLICT');
    return;
  }
  if (!facilityProfileId) throw new HttpError('CLOSURE_FACILITY_REQUIRED');
  const facility = await facilitiesService.findFacilityProfileById(facilityProfileId);
  if (!facility) {
    throw new HttpError('FACILITY_NOT_FOUND', 'The facility named by this closure does not exist.');
  }
}

/**
 * Booked appointments inside a window, read through the appointments module's
 * service (hard rule 4 — never its repository). The import is dynamic because
 * appointments/services imports this module at load time; a static import here
 * would be a require cycle in the compiled CommonJS build. The read runs under
 * the caller's RLS context, so the admin request that creates a closure sees
 * the appointments it must report.
 */
async function findBookingsInWindow(from: Date, to: Date): Promise<ClosureAffectedBooking[]> {
  const appointmentsService = await import('../../appointments/services/index.js');
  return appointmentsService.findScheduledAppointmentsInWindow(from, to);
}

/**
 * Applies a closure to the calendars it covers: removes the still-open slots
 * and reports the booked ones. Booked appointments are never touched.
 *
 * Two passes, the same shape as the doctor's cancel-day sweep (issue #338): a
 * booking that commits between the DELETE and the read holds a slot the DELETE
 * skipped (it was `booked`, not `open`). The second pass sweeps what the first
 * pass could not see, so a closure created while a booking is in flight neither
 * loses that booking silently nor leaves a bookable slot on a closed day.
 */
async function applyClosureToCalendar(closure: {
  scope: ClosureScopeName;
  startDate: Date;
  endDate: Date;
  timeZone: string;
}): Promise<ClosureApplication> {
  const windows = applicableClosureWindows(closure);
  const result: ClosureApplication = { openSlotsRemoved: 0, affectedBookings: [] };
  if (windows.length === 0) return result;

  const seen = new Set<string>();
  for (let pass = 0; pass < 2; pass += 1) {
    let removedThisPass = 0;
    for (const window of windows) {
      const removed = await availabilityRepo.deleteOpenSlotsInWindow(prisma, window.start, window.end);
      removedThisPass += removed.count;
    }
    result.openSlotsRemoved += removedThisPass;

    for (const window of windows) {
      for (const booking of await findBookingsInWindow(window.start, window.end)) {
        if (seen.has(booking.appointmentId)) continue;
        seen.add(booking.appointmentId);
        result.affectedBookings.push(booking);
      }
    }

    // Nothing was removed in this pass: there is no booking race left to catch.
    if (removedThisPass === 0) break;
  }
  return result;
}

/** Admin: create a closure and apply it to the calendar in the same call. */
export async function createClosurePeriod(actor: auditService.AuditActor, input: ClosurePeriodInput) {
  const timeZone = input.timeZone ?? 'UTC';
  assertValidTimeZone(timeZone);
  assertClosureRange(input.startDate, input.endDate);
  await assertClosureScope(input.scope, input.facilityProfileId);

  const closure = await prisma.$transaction(async (tx) => {
    const created = await availabilityRepo.createClosurePeriod(tx, {
      scope: input.scope,
      facilityProfileId: input.facilityProfileId ?? null,
      startDate: parseCalendarDate(input.startDate),
      endDate: parseCalendarDate(input.endDate),
      timeZone,
      reason: input.reason,
    });
    await auditService.record(tx, actor, {
      entityType: 'ClosurePeriod',
      entityId: created.id,
      action: 'closure.created',
      fromState: null,
      toState: created.scope,
      // Ids and codes only — the free-text reason is deliberately not copied
      // into the audit trail (ARCHITECTURE.md §4.10).
      metadata: {
        scope: created.scope,
        facilityProfileId: created.facilityProfileId,
        startDate: calendarDateString(created.startDate),
        endDate: calendarDateString(created.endDate),
      },
    });
    return created;
  });

  return { closure, ...(await applyClosureToCalendar(closure)) };
}

/** Public/client list: defaults to closures that have not ended yet. */
export function listClosurePeriodsNow(query: { from?: string; to?: string; scope?: ClosureScopeName }) {
  const today = utcCalendarDay(new Date());
  return listClosurePeriods({ ...query, from: query.from ?? calendarDateString(today) });
}

/** Admin list: every closure unless a range is asked for. */
export function listClosurePeriods(query: { from?: string; to?: string; scope?: ClosureScopeName }) {
  const fromDate = query.from ? parseCalendarDate(query.from) : undefined;
  const toDate = query.to ? parseCalendarDate(query.to) : undefined;
  if (fromDate && toDate && fromDate > toDate) {
    throw new HttpError('INVALID_DATE_RANGE', 'from must be before or equal to to.');
  }
  return availabilityRepo.findClosures({ fromDate, toDate, scope: query.scope });
}

export async function getClosurePeriod(id: string) {
  const closure = await availabilityRepo.findClosureById(prisma, id);
  if (!closure) throw new HttpError('CLOSURE_NOT_FOUND', 'Closure period not found.');
  return closure;
}

/**
 * Admin: move or re-describe a closure. One conditional UPDATE guarded by the
 * `If-Match` version (hard rule 7), and the calendar is re-applied afterwards
 * so an extended closure closes the days it now covers.
 */
export async function updateClosurePeriod(
  actor: auditService.AuditActor,
  id: string,
  expectedVersion: number,
  input: ClosurePeriodUpdateInput,
) {
  const existing = await availabilityRepo.findClosureById(prisma, id);
  if (!existing) throw new HttpError('CLOSURE_NOT_FOUND', 'Closure period not found.');

  const startDate = input.startDate ?? calendarDateString(existing.startDate);
  const endDate = input.endDate ?? calendarDateString(existing.endDate);
  const timeZone = input.timeZone ?? existing.timeZone;
  assertValidTimeZone(timeZone);
  assertClosureRange(startDate, endDate);

  const updated = await prisma.$transaction(async (tx) => {
    const rows = await availabilityRepo.updateClosureIfVersion(tx, id, expectedVersion, {
      startDate: parseCalendarDate(startDate),
      endDate: parseCalendarDate(endDate),
      timeZone,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    const row = rows[0];
    if (!row) return null;
    await auditService.record(tx, actor, {
      entityType: 'ClosurePeriod',
      entityId: id,
      action: 'closure.updated',
      fromState: `${calendarDateString(existing.startDate)}..${calendarDateString(existing.endDate)}`,
      toState: `${calendarDateString(row.startDate)}..${calendarDateString(row.endDate)}`,
      metadata: {
        scope: row.scope,
        facilityProfileId: row.facilityProfileId,
      },
    });
    return row;
  });

  // Zero rows on a row that exists means the version moved under us.
  if (!updated) throw versionConflict();

  return { closure: updated, ...(await applyClosureToCalendar(updated)) };
}

/**
 * Admin: delete a closure. Deleting does not restore the slots it removed —
 * the closure is a scheduling decision, not a recyclable resource; the doctor
 * regenerates availability for the day.
 */
export async function deleteClosurePeriod(actor: auditService.AuditActor, id: string) {
  const deleted = await prisma.$transaction(async (tx) => {
    const result = await availabilityRepo.deleteClosurePeriod(tx, id);
    if (result.count === 0) return false;
    await auditService.record(tx, actor, {
      entityType: 'ClosurePeriod',
      entityId: id,
      action: 'closure.deleted',
      fromState: null,
      toState: null,
      metadata: {},
    });
    return true;
  });
  if (!deleted) throw new HttpError('CLOSURE_NOT_FOUND', 'Closure period not found.');
}
