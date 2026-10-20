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
import { HttpError } from '../../../http-error';
import type { Prisma, ReferralStatus } from '@prisma/client';
import * as referralsRepo from '../repositories';
import * as appointmentsService from '../../appointments/services';
import * as auditService from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as patientsService from '../../patients/services';
import { evaluateReferralLoop, LoopGuardError, REFERRAL_MAX_HOPS } from '../loop';

/** How many referral-origin no-shows it takes to give up on a referral
 * (PRD §8.2.3: "repeated no-shows → expired"). Two is a deliberately
 * boring v1 default, not a tuned threshold — revisit when real no-show
 * data exists. Lives here, not in config, so the cascade and its tests
 * read from one place. */
export const NO_SHOW_EXPIRY_THRESHOLD = 2;

export interface ReferralTargetInput {
  targetDoctorId: string;
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
  parentReferralId?: string;
  loopFlaggedAt?: Date;
  loopFlagReason?: string;
}

/**
 * Shared validation for one referral target against its source
 * consultation. Returns the fully-prepared row data (lineage + loop flag
 * resolved) or throws. `existingTargets` guards the multi-referral batch
 * case (#66): two targets in one batch may not share a doctor or
 * specialty.
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
): Promise<PreparedReferral> {
  if (!consultation.appointment) {
    throw new HttpError(422, 'Consultation has no appointment; lineage cannot be established.');
  }
  if (consultation.appointment.doctorProfileId !== referringDoctorId) {
    throw new HttpError(403, 'You can only refer from your own consultation.');
  }
  if (consultation.appointment.status !== 'completed') {
    throw new HttpError(409, 'A referral requires a completed appointment.');
  }

  const patientProfileId = consultation.appointment.patientProfileId;

  if (target.targetDoctorId === referringDoctorId) {
    throw new HttpError(422, 'A doctor cannot refer a patient to themselves.');
  }
  await doctorsService.assertDoctorVerified(target.targetDoctorId);
  if (target.targetSpecialtyId) {
    await doctorsService.assertDoctorVerifiedInSpecialty(target.targetDoctorId, target.targetSpecialtyId);
  }

  const duplicateInBatch = existingTargets.some(
    (other) =>
      other.targetDoctorId === target.targetDoctorId ||
      (!!target.targetSpecialtyId && other.targetSpecialtyId === target.targetSpecialtyId),
  );
  if (duplicateInBatch) {
    throw new HttpError(422, 'Duplicate target doctor or specialty in this set of referrals.');
  }

  const duplicateInConsultation = await referralsRepo.findByConsultationAndTarget(db, consultation.id, {
    targetDoctorId: target.targetDoctorId,
    targetSpecialtyId: target.targetSpecialtyId ?? null,
  });
  if (duplicateInConsultation) {
    throw new HttpError(409, 'A referral to this doctor or specialty already exists for this consultation.');
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
        targetDoctorId: target.targetDoctorId,
        targetSpecialtyId: target.targetSpecialtyId ?? null,
      });
      if (evaluation.flagged) {
        loopFlaggedAt = new Date();
        loopFlagReason = evaluation.reason ?? undefined;
      }
    } catch (error) {
      if (error instanceof LoopGuardError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
  }

  return {
    patientProfileId,
    sourceConsultationId: consultation.id,
    referringDoctorId,
    targetDoctorId: target.targetDoctorId,
    targetSpecialtyId: target.targetSpecialtyId,
    snapshotNotes: target.snapshotNotes,
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
  if (!consultation) throw new HttpError(404, 'Consultation not found.');
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
    throw new HttpError(422, 'At least one referral target is required.');
  }
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);

  return prisma.$transaction(async (tx) => {
    const consultation = await loadConsultationForReferringDoctor(tx, sourceConsultationId);
    const accepted: { targetDoctorId: string; targetSpecialtyId?: string | null }[] = [];
    const created = [];
    for (const target of targets) {
      const prepared = await prepareReferralTarget(tx, consultation, referringDoctor.id, target, accepted);
      created.push(await referralsRepo.createReferral(tx, prepared));
      accepted.push({
        targetDoctorId: target.targetDoctorId,
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
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(actor.userId);

  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError(404, 'Referral not found.');
    if (referral.patientProfileId !== patientProfile.id) {
      throw new HttpError(403, 'This referral is not for you.');
    }
    if (referral.status !== 'pending') {
      throw new HttpError(409, 'Only a pending referral can be accepted.');
    }

    // Conditional pending → accepted FIRST: if two accepts race, exactly
    // one matches, same shape as claimOpenSlot (hard rule 2's philosophy,
    // applied to referral state).
    const claimed = await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'pending', resultingAppointmentId: null },
      { status: 'accepted' },
    );
    if (claimed.count !== 1) {
      throw new HttpError(409, 'This referral is no longer pending.');
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
      metadata: { appointmentId: appointment.id },
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
 */
export async function declineReferral(actor: auditService.AuditActor, referralId: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const patientProfile = await patientsService.getMyPatientProfile(actor.userId);
  return prisma.$transaction(async (tx) => {
    const referral = await referralsRepo.findReferralById(tx, referralId);
    if (!referral) throw new HttpError(404, 'Referral not found.');
    if (referral.patientProfileId !== patientProfile.id) {
      throw new HttpError(403, 'This referral is not for you.');
    }
    if (referral.status !== 'pending') {
      throw new HttpError(409, 'Only a pending referral can be declined.');
    }

    const updated = await referralsRepo.updateReferralConditional(
      tx,
      { id: referralId, status: 'pending', resultingAppointmentId: null },
      { status: 'declined' },
    );
    if (updated.count !== 1) {
      throw new HttpError(409, 'This referral is no longer pending.');
    }

    await auditService.record(tx, actor, {
      entityType: 'Referral',
      entityId: referralId,
      action: 'referral.declined',
      fromState: 'pending',
      toState: 'declined',
    });

    return referralsRepo.findReferralById(tx, referralId);
  });
}

export async function listMine(userId: string) {
  const patientProfile = await patientsService.getMyPatientProfile(userId);
  return referralsRepo.listReferralsForPatient(patientProfile.id);
}

export async function listCreated(userId: string) {
  const referringDoctor = await doctorsService.getMyDoctorProfile(userId);
  return referralsRepo.listReferralsCreatedBy(referringDoctor.id);
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
  input: { appointmentId: string; referralId: string; status: 'completed' | 'cancelled' | 'no_show' },
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

  if (input.status === 'cancelled') {
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

// ---------------------------------------------------------------------------
// Admin operations (issue #68)
// ---------------------------------------------------------------------------

export interface AdminQueueFilters {
  status?: ReferralStatus;
  /** Duration string like "48h" or "7d". Referrals created BEFORE now -
   * duration are returned. */
  olderThan?: string;
  loopFlagged?: boolean;
}

function parseDuration(value: string): number {
  const match = /^(\d+)([hd])$/.exec(value.trim());
  if (!match) throw new HttpError(400, 'olderThan must look like "48h" or "7d".');
  const amount = Number(match[1]);
  return match[2] === 'h' ? amount * 60 * 60 * 1000 : amount * 24 * 60 * 60 * 1000;
}

/** Issue #68 queue endpoint: stuck referrals (by status + age) and/or
 * loop-flagged ones, with a derived human-readable reason and age. */
export async function adminListReferrals(_userId: string, filters: AdminQueueFilters) {
  const createdBefore = filters.olderThan ? new Date(Date.now() - parseDuration(filters.olderThan)) : undefined;
  const rows = await referralsRepo.listAdminQueue({
    status: filters.status,
    createdBefore,
    loopFlagged: filters.loopFlagged,
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
    if (!referral) throw new HttpError(404, 'Referral not found.');

    // Reassigning an accepted referral would strand its live appointment
    // against the old doctor — cancel that path; admins cancel instead.
    if (referral.status !== 'pending') {
      throw new HttpError(409, 'Only a pending referral can be reassigned.');
    }
    if (input.targetDoctorId === referral.referringDoctorId) {
      throw new HttpError(422, 'A doctor cannot be referred to themselves.');
    }
    if (referral.targetSpecialtyId) {
      await doctorsService.assertDoctorVerifiedInSpecialty(input.targetDoctorId, referral.targetSpecialtyId);
    } else {
      await doctorsService.assertDoctorVerified(input.targetDoctorId);
    }
    if (input.targetDoctorId === referral.targetDoctorId) {
      throw new HttpError(409, 'Referral already targets that doctor.');
    }

    const updated = await referralsRepo.updateReferralIfStatus(tx, referralId, 'pending', {
      targetDoctorId: input.targetDoctorId,
    });
    if (updated.count !== 1) {
      throw new HttpError(409, 'Referral is no longer pending; it changed while you were working.');
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
    if (!referral) throw new HttpError(404, 'Referral not found.');
    if (referral.status !== 'pending' && referral.status !== 'accepted') {
      throw new HttpError(409, 'Only a pending or accepted referral can be cancelled.');
    }

    // Accepted + live appointment: close the appointment first (inside
    // this transaction) WITHOUT the normal cascade — we know we're
    // cancelling the referral, no need for it to bounce back to pending.
    if (referral.status === 'accepted' && referral.resultingAppointmentId) {
      await appointmentsService.forceCancelAppointment(tx, referral.resultingAppointmentId);
    }

    const updated = await referralsRepo.updateReferralIfStatus(tx, referralId, ['pending', 'accepted'], {
      status: 'cancelled',
      cancelledReason: input.reason,
    });
    if (updated.count !== 1) {
      throw new HttpError(409, 'Referral changed while you were working; reload and retry.');
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
  if (!referral) throw new HttpError(404, 'Referral not found.');
  const page = await auditService.listAuditEvents({
    entityType: 'Referral',
    entityId: referralId,
    limit: 200,
  });
  return page.items;
}
