// Referrals services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
//
// NOTE: this module and appointments/services import each other (accept
// creates an appointment via the appointments service; appointment status
// changes cascade back through applyAppointmentOutcome below; admin cancel
// closes a live appointment through forceCancelAppointment). The cycle is
// runtime-safe under ESM live bindings — every cross-call happens inside
// an async function, after both modules have finished loading — and is
// the smallest seam that keeps each module owning its own table
// (ARCHITECTURE.md §3 / ARCHITECTURE_ESSENTIALS.md hard rule 4).
import { prisma } from '../../../db/prisma-client';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import type { Prisma, ReferralStatus, ReferralDeclineReason } from '@prisma/client';
import * as referralsRepo from '../repositories';
import * as appointmentsService from '../../appointments/services';
import * as auditService from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import * as intakeService from '../../intake/services';
import { decryptField, encryptField, isEncrypted } from '../../../utils/field-encryption';
import { evaluateReferralLoop, LoopGuardError, REFERRAL_MAX_HOPS } from '../loop';
import { selectLeastLoaded } from '../routing';

/** How many referral-origin no-shows it takes to give up on a referral
 * (PRD §8.2.3: "repeated no-shows → expired"). Two is a deliberately
 * boring v1 default, not a tuned threshold — revisit when real no-show
 * data exists. Lives here, not in config, so the cascade and its tests
 * read from one place. */
export const NO_SHOW_EXPIRY_THRESHOLD = 2;

export interface ReferralTargetInput {
  /** Explicit recipient. When omitted, `targetSpecialtyId` is required and
   * routing picks a doctor (issue #6, docs/adr/0008). */
  targetDoctorId?: string;
  targetSpecialtyId?: string;
  snapshotNotes: string;
}

export interface CreateReferralInput extends ReferralTargetInput {
  sourceConsultationId: string;
}

interface PreparedReferral {
  patientProfileId: string;
  sourceConsultationId: string;
  referringDoctorId: string;
  targetDoctorId: string;
  targetSpecialtyId?: string;
  snapshotNotes: string;
  snapshotIntake: string | null;
  parentReferralId?: string;
  loopFlaggedAt?: Date;
  loopFlagReason?: string;
}

/**
 * Resolve a target to a concrete doctor (issue #6, docs/adr/0008):
 * an explicit `targetDoctorId` is returned untouched; a specialty-only
 * target is routed to the least-loaded eligible doctor in that specialty.
 * `excludeDoctorIds` carries the ids this batch must not route to (the
 * referring doctor is always excluded by the eligibility query).
 *
 * Throws 422 when nobody is eligible — creation then fails wholesale and
 * no unassigned referral row exists. That is the deliberate v1 answer to
 * PRD §8.2.2: the referring doctor learns at the point of referral that
 * no specialist is available, rather than handing the patient a referral
 * nobody owns.
 */
async function resolveTargetDoctor(
  db: Prisma.TransactionClient,
  referringDoctorId: string,
  target: ReferralTargetInput,
  excludeDoctorIds: string[],
): Promise<string> {
  if (target.targetDoctorId) return target.targetDoctorId;

  if (!target.targetSpecialtyId) {
    throw new HttpError('REFERRAL_TARGET_REQUIRED', 'A referral needs either a target doctor or a target specialty.');
  }

  const eligibleDoctorIds = await doctorsService.listEligibleReferralTargets(target.targetSpecialtyId, [
    referringDoctorId,
    ...excludeDoctorIds,
  ]);
  if (eligibleDoctorIds.length === 0) {
    throw new HttpError(
      'REFERRAL_NO_ELIGIBLE_TARGET',
      'No verified doctor is available to receive a referral for this specialty. Name a specific doctor instead.');
  }

  const loadRows = await referralsRepo.countActiveReferralsByTargetDoctor(db, eligibleDoctorIds);
  const loadByDoctorId = new Map(loadRows.map((row) => [row.targetDoctorId, row._count._all]));
  const chosen = selectLeastLoaded(
    eligibleDoctorIds.map((doctorProfileId) => ({
      doctorProfileId,
      activeReferralCount: loadByDoctorId.get(doctorProfileId) ?? 0,
    })),
  );
  if (!chosen) {
    // Unreachable: the candidate list is non-empty. Kept so the return
    // type is honest instead of asserted away.
    throw new HttpError(
      'REFERRAL_NO_ELIGIBLE_TARGET',
      'No verified doctor is available to receive a referral for this specialty.');
  }
  return chosen.doctorProfileId;
}

/**
 * Shared validation for one referral target against its source
 * consultation. Returns the fully-prepared row data (lineage + loop flag
 * resolved) or throws. `existingTargets` guards the multi-referral batch
 * case (#66): two targets in one batch may not share a doctor or
 * specialty. `excludeFromRouting` carries the batch's explicit targets
 * and already-routed ones, so one batch never routes a specialty-only
 * target onto a doctor the same batch named explicitly (ADR 0008 §5).
 */
async function prepareReferralTarget(
  db: Prisma.TransactionClient,
  consultation: {
    id: string;
    appointment: { patientProfileId: string; doctorProfileId: string; status: string } | null;
  },
  referringDoctorId: string,
  target: ReferralTargetInput,
  existingTargets: { targetDoctorId: string; targetSpecialtyId?: string | null }[],
  excludeFromRouting: string[] = [],
): Promise<PreparedReferral> {
  if (!consultation.appointment) {
    throw new HttpError('REFERRAL_NO_APPOINTMENT', 'Consultation has no appointment; lineage cannot be established.');
  }
  if (consultation.appointment.doctorProfileId !== referringDoctorId) {
    throw new HttpError('REFERRAL_ONLY_OWN_CONSULTATION', 'You can only refer from your own consultation.');
  }
  if (consultation.appointment.status !== 'completed') {
    throw new HttpError('REFERRAL_REQUIRES_COMPLETED_APPOINTMENT', 'A referral requires a completed appointment.');
  }

  const patientProfileId = consultation.appointment.patientProfileId;

  // Routing first: everything below (self-referral gate, verification,
  // duplicate checks, loop walk) then sees one resolved doctor regardless
  // of whether the referring doctor named them or the rule picked them.
  // Issue #334: an unknown specialty id gets its own message rather than
  // "no eligible doctor" (routing) or a foreign-key failure (insert).
  if (target.targetSpecialtyId) {
    await doctorsService.assertSpecialtyExists(target.targetSpecialtyId);
  }
  const targetDoctorId = await resolveTargetDoctor(db, referringDoctorId, target, excludeFromRouting);

  if (targetDoctorId === referringDoctorId) {
    throw new HttpError('REFERRAL_SELF', 'A doctor cannot refer a patient to themselves.');
  }
  await doctorsService.assertDoctorVerified(targetDoctorId);
  if (target.targetSpecialtyId) {
    await doctorsService.assertDoctorVerifiedInSpecialty(targetDoctorId, target.targetSpecialtyId);
  }

  const duplicateInBatch = existingTargets.some(
    (other) =>
      other.targetDoctorId === targetDoctorId ||
      (!!target.targetSpecialtyId && other.targetSpecialtyId === target.targetSpecialtyId),
  );
  if (duplicateInBatch) {
    throw new HttpError('REFERRAL_DUPLICATE_IN_BATCH', 'Duplicate target doctor or specialty in this set of referrals.');
  }

  const duplicateInConsultation = await referralsRepo.findByConsultationAndTarget(db, consultation.id, {
    targetDoctorId,
    targetSpecialtyId: target.targetSpecialtyId ?? null,
  });
  if (duplicateInConsultation) {
    throw new HttpError('REFERRAL_DUPLICATE_TARGET', 'A referral to this doctor or specialty already exists for this consultation.');
  }

  const parentReferralId =
    (await referralsRepo.findParentReferralForConsultation(db, consultation.id)) ?? undefined;

  let loopFlaggedAt: Date | undefined;
  let loopFlagReason: string | undefined;
  if (parentReferralId) {
    const ancestors = await referralsRepo.findReferralAncestors(db, parentReferralId, REFERRAL_MAX_HOPS - 1);
    try {
      const evaluation = evaluateReferralLoop(ancestors, {
        referringDoctorId,
        targetDoctorId,
        targetSpecialtyId: target.targetSpecialtyId ?? null,
      });
      if (evaluation.flagged) {
        loopFlaggedAt = new Date();
        loopFlagReason = evaluation.reason ?? undefined;
      }
    } catch (error) {
      if (error instanceof LoopGuardError) {
        throw new HttpError('REFERRAL_INVALID_TARGET', error.message);
      }
      throw error;
    }
  }

  // Capture the patient's most-recent intake form as an immutable snapshot
  // (issue #5, ARCHITECTURE.md §4.4). Null when no intake exists yet (issue
  // #2 not yet enforced). Encrypted the same way as snapshotNotes so the
  // referral row carries no plaintext PHI.
  const latestIntake = await intakeService.findLatestIntakeForReferral(db, patientProfileId);
  const snapshotIntake = latestIntake
    ? (encryptField(JSON.stringify(latestIntake)) ?? null)
    : null;

  return {
    patientProfileId,
    sourceConsultationId: consultation.id,
    referringDoctorId,
    targetDoctorId,
    targetSpecialtyId: target.targetSpecialtyId,
    snapshotNotes: target.snapshotNotes,
    snapshotIntake,
    parentReferralId,
    loopFlaggedAt,
    loopFlagReason,
  };
}

async function loadConsultationForReferringDoctor(db: Prisma.TransactionClient, sourceConsultationId: string) {
  const consultation = await db.consultation.findUnique({
    where: { id: sourceConsultationId },
    include: { appointment: true },
  });
  if (!consultation) throw new HttpError('CONSULTATION_NOT_FOUND', 'Consultation not found.');
  return consultation;
}

/**
 * Single referral creation (issues #5/#65/#66/#67 foundation). One
 * transaction per call — the loop walk, duplicate check and insert are
 * atomic, so a concurrent identical referral loses the race on the
 * duplicate check or not at all.
 */
export async function createReferral(userId: string, input: CreateReferralInput) {
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);

  return prisma.$transaction(async (tx) => {
    const consultation = await loadConsultationForReferringDoctor(tx, input.sourceConsultationId);
    const prepared = await prepareReferralTarget(tx, consultation, referringDoctor.id, input, []);
    return referralsRepo.createReferral(tx, prepared);
  });
}

/**
 * Multiple simultaneous referrals from one consultation (issue #66, PRD
 * §8.2.4). All-or-none: the whole batch shares one transaction, so a
 * failure on the second target rolls back the first. Each target gets its
 * OWN snapshot copy (FR-7/FR-8) — two rows, two notes, never a shared
 * reference. Acceptance/decline stays per-referral: they are independent
 * lifecycles that merely happen to be born together.
 */
export async function createReferralBatch(
  userId: string,
  sourceConsultationId: string,
  targets: ReferralTargetInput[],
) {
  if (targets.length === 0) {
    throw new HttpError('REFERRAL_TARGETS_REQUIRED', 'At least one referral target is required.');
  }
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);

  return prisma.$transaction(async (tx) => {
    const consultation = await loadConsultationForReferringDoctor(tx, sourceConsultationId);
    const accepted: { targetDoctorId: string; targetSpecialtyId?: string | null }[] = [];
    // Explicitly named doctors are off-limits to this batch's routing
    // regardless of target order (ADR 0008 §5), so "cardiology (any) +
    // Dr A" can never route the specialty half onto Dr A and then fail
    // the duplicate check for a reason the doctor never chose.
    const explicitlyTargeted = targets
      .map((target) => target.targetDoctorId)
      .filter((id): id is string => !!id);
    const created = [];
    for (const target of targets) {
      const prepared = await prepareReferralTarget(tx, consultation, referringDoctor.id, target, accepted, [
        ...explicitlyTargeted,
        ...accepted.map((entry) => entry.targetDoctorId),
      ]);
      created.push(await referralsRepo.createReferral(tx, prepared));
      accepted.push({
        targetDoctorId: prepared.targetDoctorId,
        targetSpecialtyId: target.targetSpecialtyId ?? null,
      });
    }
    return created;
  });
}

/**
 * Patient accepts a pending referral: one transaction that flips the
 * referral pending → accepted (conditional — the concurrency gate), then
 * books the pre-populated appointment against the target doctor through
 * the appointments service (slot claim + Appointment row, origin
 * 'referral'). The patient picks the slot; the appointment is
 * "pre-populated" in the FR-8 sense — no re-intake, the snapshot travels
 * on the referral — not in the sense of an auto-chosen time.
 */
export async function acceptReferral(
  actor: auditService.AuditActor,
  referralId: string,
  availabilitySlotId: string,
  patientProfileId?: string,
) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  // Issue #305: no patientProfileId keeps the self-service path; naming one
  // resolves an active guardianship (or the caller's own profile) first, so
  // an ended guardianship is refused before the referral is touched.
  const patientProfile = patientProfileId
    ? await patientsService.resolveActingProfile(actor.userId, patientProfileId)
    : await patientsService.getMyPatientProfile(actor.userId);

  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');
    if (referral.patientProfileId !== patientProfile.id) {
      throw new HttpError('REFERRAL_NOT_YOURS', 'This referral is not for you.');
    }
    if (referral.status !== 'pending') {
      throw new HttpError('REFERRAL_NOT_ACCEPTABLE', 'Only a pending referral can be accepted.');
    }

    // Ensure the target doctor is active (not deactivated or deleted)
    await doctorsService.assertDoctorActive(referral.targetDoctorId, tx);

    // Conditional pending → accepted FIRST: if two accepts race, exactly
    // one matches, same shape as claimOpenSlot (hard rule 2's philosophy,
    // applied to referral state).
    const claimed = await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'pending', resultingAppointmentId: null },
      { status: 'accepted' },
    );
    if (claimed.count !== 1) {
      throw new HttpError('REFERRAL_NOT_PENDING', 'This referral is no longer pending.');
    }

    const appointment = await appointmentsService.bookForReferral(
      tx,
      {
        patientProfileId: patientProfile.id,
        doctorProfileId: referral.targetDoctorId,
        availabilitySlotId,
        referralId,
      },
      actor,
    );

    await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'accepted', resultingAppointmentId: null },
      { resultingAppointmentId: appointment.id },
    );

    // The patient's own state change on the referral, recorded in the same
    // transaction as the appointment it produced — so the trail shows who
    // accepted, and the `appointment.booked` row the appointments module
    // wrote, together or not at all.
    await auditService.record(tx, actor, {
      entityType: 'Referral',
      entityId: referralId,
      action: 'referral.accepted',
      fromState: 'pending',
      toState: 'accepted',
      metadata: { appointmentId: appointment.id, patientProfileId: patientProfile.id },
    });

    return referralsRepo.findReferralById(tx, referralId);
  });
}

/**
 * Patient declines a pending referral. Deliberately pending-only: once a
 * referral is accepted it has a live appointment behind it, and the way
 * out is cancelling that appointment — which the cascade below returns to
 * pending (re-bookable), from which declining is then possible. Keeps one
 * narrow transition instead of two overlapping exit paths.
 *
 * Issue #309: optional reason when a patient declines a referral. The reason
 * is stored on the referral record and included in the audit metadata. When
 * no reason is provided (omitted body), the referral is declined without a
 * reason — backwards compatible.
 */
export async function declineReferral(
  actor: auditService.AuditActor,
  referralId: string,
  patientProfileId?: string,
  reason?: { enum?: ReferralDeclineReason; note?: string },
) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const patientProfile = patientProfileId
    ? await patientsService.resolveActingProfile(actor.userId, patientProfileId)
    : await patientsService.getMyPatientProfile(actor.userId);
  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');
    if (referral.patientProfileId !== patientProfile.id) {
      throw new HttpError('REFERRAL_NOT_YOURS', 'This referral is not for you.');
    }
    if (referral.status !== 'pending') {
      throw new HttpError('REFERRAL_NOT_DECLINABLE', 'Only a pending referral can be declined.');
    }

    // Issue #309: resolve the optional decline reason once for both the row
    // write and the audit metadata, so the two can never disagree.
    const declineReason = reason?.enum;
    const declineReasonNote = reason?.note && reason.note.trim() ? reason.note.trim() : null;

    const updated = await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'pending', resultingAppointmentId: null },
      { status: 'declined', declineReason, declineReasonNote },
    );
    if (updated.count !== 1) {
      throw new HttpError('REFERRAL_NOT_PENDING', 'This referral is no longer pending.');
    }

    // Only the enum goes into the audit metadata. The free-text note is
    // patient-written and may carry PHI, which the audit guard keeps out of
    // metadata (it rejects "note"-like keys), so it stays on the referral row.
    const auditMetadata: auditService.AuditMetadata = { patientProfileId: patientProfile.id };
    if (declineReason) auditMetadata.declineReason = declineReason;

    await auditService.record(tx, actor, {
      entityType: 'Referral',
      entityId: referralId,
      action: 'referral.declined',
      fromState: 'pending',
      toState: 'declined',
      metadata: auditMetadata,
    });

    return referralsRepo.findReferralById(tx, referralId);
  });
}

export async function withdrawReferral(
  actor: auditService.AuditActor,
  referralId: string,
  input: { reason: string },
) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const referringDoctor = await doctorsService.getMyDoctorProfile(actor.userId);

  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral || referral.referringDoctorId !== referringDoctor.id) {
      throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');
    }
    if (referral.status !== 'pending') {
      throw new HttpError('REFERRAL_NOT_WITHDRAWABLE', 'Only a pending referral can be withdrawn.');
    }

    const updated = await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'pending', resultingAppointmentId: null },
      { status: 'cancelled', cancelledReason: input.reason },
    );
    if (updated.count !== 1) {
      throw new HttpError('REFERRAL_NOT_PENDING', 'This referral is no longer pending.');
    }

    await auditService.record(tx, actor, {
      entityType: 'Referral',
      entityId: referralId,
      action: 'referral.withdraw',
      fromState: 'pending',
      toState: 'cancelled',
      metadata: { reason: input.reason },
    });

    return referralsRepo.findReferralById(tx, referralId);
  });
}

export async function listMine(userId: string, patientProfileId?: string) {
  const patientProfile = patientProfileId
    ? await patientsService.resolveActingProfile(userId, patientProfileId)
    : await patientsService.getMyPatientProfile(userId);
  const referrals = await referralsRepo.listReferralsForPatient(patientProfile.id);
  const detail = patientProfile.userId === null ? 'referral list read (guardian)' : 'referral list read';
  for (const referral of referrals) {
    auditService.recordAccess({
      accessedBy: userId,
      patientProfileId: patientProfile.id,
      entityType: 'Referral',
      entityId: referral.id,
      route: 'GET /referrals/mine',
      detail,
    });
  }
  return referrals;
}

export async function listCreated(userId: string) {
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);
  // Issue #309: the rows carry `declineReason` and `declineReasonNote` as
  // model scalars, so the referring doctor sees why the patient declined
  // without a second query.
  return referralsRepo.listReferralsCreatedBy(referringDoctor.id);
}

const DEFAULT_INCOMING_REFERRAL_STATUSES: ReferralStatus[] = ['pending', 'accepted'];

function encodeIncomingCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeIncomingCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator < 1 || Number.isNaN(createdAt.getTime()) || !id) {
    throw new HttpError('INVALID_CURSOR', 'Invalid cursor.');
  }
  return { createdAt, id };
}

function readableSnapshotNotes(value: string): string {
  return isEncrypted(value) ? decryptField(value) ?? value : value;
}

function readableSnapshotIntake(value: string | null): unknown {
  if (!value) return null;
  const raw = isEncrypted(value) ? decryptField(value) ?? value : value;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function getReferralDetail(
  actor: auditService.AuditActor,
  referralId: string,
  patientProfileId?: string,
) {
  if (!actor.userId) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');
  const referral = await referralsRepo.findReferralById(prisma, referralId);
  if (!referral) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');

  let authorized = false;
  if (actor.role === 'admin') {
    authorized = true;
  } else if (actor.role === 'doctor') {
    const doctor = await doctorsService.getMyDoctorProfile(actor.userId);
    authorized = doctor.id === referral.referringDoctorId || doctor.id === referral.targetDoctorId;
  } else if (actor.role === 'patient') {
    const actingProfile = await patientsService.resolveActingProfile(actor.userId, patientProfileId);
    authorized = actingProfile.id === referral.patientProfileId;
  }

  if (!authorized) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');

  auditService.recordAccess({
    accessedBy: actor.userId,
    patientProfileId: referral.patientProfileId,
    entityType: 'Referral',
    entityId: referral.id,
    route: 'GET /referrals/:referralId',
    detail: 'referral detail read',
  });

  return {
    ...referral,
    snapshotNotes: readableSnapshotNotes(referral.snapshotNotes),
    snapshotIntake: readableSnapshotIntake(referral.snapshotIntake),
  };
}

export interface IncomingReferralFilters {
  status?: ReferralStatus;
  limit?: number;
  cursor?: string;
}

export async function listIncoming(userId: string, filters: IncomingReferralFilters) {
  const doctor = await doctorsService.getMyDoctorProfile(userId);
  const limit = filters.limit ?? 20;
  const before = filters.cursor ? decodeIncomingCursor(filters.cursor) : undefined;
  const rows = await referralsRepo.listIncomingReferrals({
    targetDoctorId: doctor.id,
    statuses: filters.status ? [filters.status] : DEFAULT_INCOMING_REFERRAL_STATUSES,
    before,
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map((row) => ({
    ...row,
    snapshotNotes: readableSnapshotNotes(row.snapshotNotes),
    snapshotIntake: readableSnapshotIntake(row.snapshotIntake),
  }));

  for (const row of pageRows) {
    auditService.recordAccess({
      accessedBy: userId,
      patientProfileId: row.patientProfileId,
      entityType: 'Referral',
      entityId: row.id,
      route: 'GET /referrals/incoming',
      detail: 'incoming referral read',
    });
  }

  const last = pageRows.at(-1);
  return { items, nextCursor: hasMore && last ? encodeIncomingCursor(last) : null };
}

/**
 * THE cascade (issue #67, PRD §8.2.3). Called by appointments/services
 * inside the same transaction as the appointment's status transition, so
 * the referral can never be left sitting `accepted` behind a dead
 * appointment:
 *
 *   completed → referral `completed` (closes FR-9's loop; keeps
 *               referral-completion metrics honest)
 *   cancelled → referral back to `pending`, re-bookable — re-accepting
 *               reuses the same snapshot, no re-intake (FR-8); the
 *               cancelled appointment keeps its own referralId link, so
 *               history survives the resultingAppointmentId being cleared
 *   no_show   → noShowCount++, referral back to `pending`; once the count
 *               reaches NO_SHOW_EXPIRY_THRESHOLD the referral is
 *               `expired` instead, with referringDoctorNotifiedAt set —
 *               the flag the referring doctor's view reads (Phase 6 can
 *               later turn it into a real notification)
 *
 * Idempotency: every write is a conditional UPDATE that only matches a
 * referral still `accepted` *and still pointing at this appointment* —
 * a hook that fires a second time after the first one moved the referral
 * matches zero rows and no-ops. The no_show counter therefore advances at
 * most once per real appointment transition, even if called twice.
 */
export async function applyAppointmentOutcome(
  db: Prisma.TransactionClient,
  input: { appointmentId: string; referralId: string; status: 'completed' | 'cancelled' | 'late_cancelled' | 'no_show' },
) {
  const stillAccepted = {
    id: input.referralId,
    status: 'accepted' as const,
    resultingAppointmentId: input.appointmentId,
  };

  if (input.status === 'completed') {
    await referralsRepo.updateReferralConditional(db, stillAccepted, { status: 'completed' });
    return;
  }

  if (input.status === 'cancelled' || input.status === 'late_cancelled') {
    await referralsRepo.updateReferralConditional(db, stillAccepted, {
      status: 'pending',
      resultingAppointmentId: null,
    });
    return;
  }

  // no_show: read the current count to decide pending-vs-expired, then
  // write conditionally. Safe under the caller's transaction: the
  // appointment row was just updated under the same tx (locking it), and
  // resultingAppointmentId is singular — no second accepted appointment
  // can be racing on this referral.
  const referral = await referralsRepo.findReferralById(db, input.referralId);
  if (!referral || referral.status !== 'accepted' || referral.resultingAppointmentId !== input.appointmentId) {
    return; // already processed (or never matched) — idempotent no-op
  }

  const noShowCount = referral.noShowCount + 1;
  if (noShowCount >= NO_SHOW_EXPIRY_THRESHOLD) {
    await referralsRepo.updateReferralConditional(db, stillAccepted, {
      status: 'expired',
      noShowCount,
      referringDoctorNotifiedAt: new Date(),
      expiredAt: new Date(),
      expiredReason: 'no_show',
      // resultingAppointmentId intentionally kept: the appointment that
      // produced the expiring no-show stays linked as the reason.
    });
  } else {
    await referralsRepo.updateReferralConditional(db, stillAccepted, {
      status: 'pending',
      noShowCount,
      resultingAppointmentId: null,
    });
  }
}

/** This module's contribution to the patient data export (issue #336).
 * Referrals include their immutable snapshot notes, lineage, and status. */
export const referralsExportSection: patientsService.PatientExportSection = {
  name: 'referrals',
  version: 1,
  pages(subject, pageSize) {
    return patientsService.paginate(
      pageSize,
      (cursor, take) => referralsRepo.findReferralsPageForPatient(subject.patientProfileId, cursor, take),
      (rows) => rows.map((row) => ({
        id: row.id,
        status: row.status,
        noShowCount: row.noShowCount,
        referringDoctorId: row.referringDoctorId,
        targetDoctorId: row.targetDoctorId,
        targetSpecialtyId: row.targetSpecialtyId,
        // Clinical text is stored encrypted; the export is for the patient
        // to read, so it carries the plaintext (issue #336).
        snapshotNotes: readableSnapshotNotes(row.snapshotNotes),
        declineReason: row.declineReason,
        createdAt: row.createdAt,
        expiredAt: row.expiredAt,
        expiredReason: row.expiredReason,
      })),
    );
  },
};

// ---------------------------------------------------------------------------
// Time-based expiry (issue #8)
// ---------------------------------------------------------------------------

/**
 * Expires referrals that have sat `pending` for longer than
 * `REFERRAL_PENDING_TTL_DAYS` (PRD §8.1.3 "orphaned" referrals). The clock is
 * `updatedAt`, not `createdAt`: a referral the cascade returned to `pending`
 * (cancelled/no-showed appointment, issue #67) or an admin reassigned
 * (issue #68) gets a fresh window instead of being expired the moment it
 * re-enters the queue. `accepted` referrals are never touched — they have an
 * appointment; that lifecycle belongs to the cascade.
 *
 * The result is `expired` with `expiredReason = 'ttl'` — a different terminal
 * state from `declined` (the patient said no) and `cancelled` (an admin
 * closed it). Safe to run from several processes and to re-run.
 */
export async function expireStaleReferrals(now: Date = new Date()): Promise<{ expired: number }> {
  const cutoff = new Date(now.getTime() - config.referrals.pendingTtlDays * 24 * 60 * 60 * 1000);
  const result = await referralsRepo.expireStalePendingReferrals(prisma, cutoff, now);
  return { expired: result.count };
}

// ---------------------------------------------------------------------------
// Admin operations (issue #68)
// ---------------------------------------------------------------------------

export interface AdminQueueFilters {
  status?: ReferralStatus;
  /** Duration string like "48h" or "7d". Referrals created BEFORE now -
   * duration are returned. */
  olderThan?: string;
  loopFlagged?: boolean;
  targetSpecialtyId?: string;
  targetDoctorId?: string;
}

function parseDuration(value: string): number {
  const match = /^(\d+)([hd])$/.exec(value.trim());
  if (!match) throw new HttpError('INVALID_OLDER_THAN', 'olderThan must look like "48h" or "7d".');
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
}

/** Issue #68 + #339 queue endpoint: stuck referrals (by status + age + specialty + doctor)
 * and/or loop-flagged ones, with a derived human-readable reason and age. */
export async function adminListReferrals(_userId: string, filters: AdminQueueFilters) {
  const createdBefore = filters.olderThan ? new Date(Date.now() - parseDuration(filters.olderThan)) : undefined;
  const rows = await referralsRepo.listAdminQueue({
    status: filters.status,
    createdBefore,
    loopFlagged: filters.loopFlagged,
    targetSpecialtyId: filters.targetSpecialtyId,
    targetDoctorId: filters.targetDoctorId,
  });

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    ageMinutes: Math.floor((now - row.createdAt.getTime()) / 60_000),
    reason: deriveQueueReason(row),
  }));
}

function deriveQueueReason(row: {
  loopFlaggedAt: Date | null;
  loopFlagReason: string | null;
  noShowCount: number;
  status: ReferralStatus;
}): string {
  if (row.loopFlaggedAt) return row.loopFlagReason ?? 'loop-flagged';
  if (row.noShowCount > 0) return `previous no-shows (${row.noShowCount})`;
  if (row.status === 'pending') return 'awaiting patient acceptance';
  return 'stuck';
}

/**
 * Reassignment (issue #68): move a PENDING referral to a different
 * verified doctor, with an audit event. Only `targetDoctorId` moves —
 * the snapshot (notes, patient, consultation, lineage) is untouched, per
 * the constraint that reassignment must never alter the snapshot. The
 * target is validated through the doctors service, never around it.
 *
 * The audit event goes through the audit module's `record()` (Phase 8,
 * issue #43) — there is one AuditEvent table in this system, and this
 * module writes its rows as `entityType: 'Referral'` through that
 * module's service, never by touching the table itself.
 */
export async function adminReassign(
  actor: auditService.AuditActor,
  referralId: string,
  input: { targetDoctorId: string; reason: string },
) {
  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');

    // Reassigning an accepted referral would strand its live appointment
    // against the old doctor — cancel that path; admins cancel instead.
    if (referral.status !== 'pending') {
      throw new HttpError('REFERRAL_NOT_REASSIGNABLE', 'Only a pending referral can be reassigned.');
    }
    if (input.targetDoctorId === referral.referringDoctorId) {
      throw new HttpError('REFERRAL_SELF', 'A doctor cannot be referred to themselves.');
    }
    if (referral.targetSpecialtyId) {
      await doctorsService.assertDoctorVerifiedInSpecialty(input.targetDoctorId, referral.targetSpecialtyId);
    } else {
      await doctorsService.assertDoctorVerified(input.targetDoctorId);
    }
    if (input.targetDoctorId === referral.targetDoctorId) {
      throw new HttpError('REFERRAL_ADMIN_TARGET_DUPLICATE', 'Referral already targets that doctor.');
    }

    const updated = await referralsRepo.updateReferralIfStatus(tx, referralId, 'pending', {
      targetDoctorId: input.targetDoctorId,
    });
    if (updated.count !== 1) {
      throw new HttpError('REFERRAL_CHANGED', 'Referral is no longer pending; it changed while you were working.');
    }

    await auditService.record(tx, actor, {
      entityType: 'Referral',
      entityId: referralId,
      action: 'referral.reassign',
      // The referral's *state* doesn't change here — it stays pending and
      // is retargeted — so there is no from/to state. What changed is the
      // target doctor, which is recorded as ids in the metadata.
      fromState: null,
      toState: null,
      metadata: {
        fromDoctorId: referral.targetDoctorId,
        toDoctorId: input.targetDoctorId,
        reason: input.reason,
      },
    });

    return referralsRepo.findReferralById(tx, referralId);
  });
}

/**
 * Admin cancellation (issue #68): terminate a non-terminal referral with
 * a reason, audited. If the referral is `accepted`, its live appointment
 * is cancelled too (through the appointments service — never by touching
 * the Appointment table from here) so we don't re-create the exact
 * "dead appointment behind a live referral" bug #67 exists to prevent.
 * The patient-notification hook point is the audit event + the referral
 * status itself; Phase 6's dispatch layer will read both.
 */
export async function adminCancel(
  actor: auditService.AuditActor,
  referralId: string,
  input: { reason: string },
) {
  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');
    if (referral.status !== 'pending' && referral.status !== 'accepted') {
      throw new HttpError('REFERRAL_NOT_CANCELLABLE', 'Only a pending or accepted referral can be cancelled.');
    }

    // Accepted + live appointment: close the appointment first (inside
    // this transaction) WITHOUT the normal cascade — we know we're
    // cancelling the referral, no need for it to bounce back to pending.
    if (referral.status === 'accepted' && referral.resultingAppointmentId) {
      await appointmentsService.forceCancelAppointment(tx, referral.resultingAppointmentId, actor);
    }

    const updated = await referralsRepo.updateReferralIfStatus(tx, referralId, ['pending', 'accepted'], {
      status: 'cancelled',
      cancelledReason: input.reason,
    });
    if (updated.count !== 1) {
      throw new HttpError('REFERRAL_CHANGED', 'Referral changed while you were working; reload and retry.');
    }

    await auditService.record(tx, actor, {
      entityType: 'Referral',
      entityId: referralId,
      action: 'referral.cancel',
      fromState: referral.status,
      toState: 'cancelled',
      metadata: { reason: input.reason },
    });

    return referralsRepo.findReferralById(tx, referralId);
  });
}

/**
 * A referral's audit trail (issue #68). Read through the audit module's
 * service — this module never queries the AuditEvent table itself. The
 * rows are the same ones the admin-wide `GET /admin/audit-events`
 * endpoint serves, narrowed to this referral.
 */
export async function listAuditEvents(referralId: string) {
  const referral = await referralsRepo.findReferralById(prisma, referralId);
  if (!referral) throw new HttpError('REFERRAL_NOT_FOUND', 'Referral not found.');
  const page = await auditService.listAuditEvents({
    entityType: 'Referral',
    entityId: referralId,
    limit: 200,
  });
  return page.items;
}

/** Retention hold (issue #41, docs/adr/0010): a referral carries an
 * immutable clinical snapshot, so a patient who has any is never purged
 * after deletion. */
export function hasReferralsForPatient(patientProfileId: string): Promise<boolean> {
  return referralsRepo.patientHasReferrals(patientProfileId);
}
