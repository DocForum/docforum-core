// Abnormal/critical lab result acknowledgement (Phase 4, issue #72,
// PRD §8.2.7).
//
// A result that is not `normal` opens a task for the ordering doctor in the
// same transaction as the result (see ./lab-results.ts). This file owns the
// doctor's acknowledgement, the two read paths (doctor queue, admin escalation
// queue) and the escalation sweep.
//
// Invariants:
//  - acknowledgement is written ONCE, by a conditional UPDATE
//    (`acknowledgedAt IS NULL`), and recorded in the shared append-only
//    AuditEvent table — there is no second audit trail;
//  - escalation is a conditional UPDATE too (`acknowledgedAt IS NULL AND
//    escalatedAt IS NULL`), so two job runners cannot double-escalate and an
//    acknowledgement that wins the race is never escalated;
//  - `overdue` is derived from `escalationDueAt` on read, so a missed job tick
//    is visible immediately rather than hiding behind an unset `escalatedAt`.
import type { Role } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import { record as recordAudit, SYSTEM_ACTOR, type AuditActor } from '../../audit/services';
import * as doctorsService from '../../doctors/services';
import * as repo from '../repositories';

const ACK_REQUIRED_NOT_FOUND = 'No acknowledgement is required for this lab result.';

export interface UnacknowledgedResultView {
  labResultId: string;
  labOrderId: string;
  orderingDoctorId: string;
  severity: string;
  escalationDueAt: Date;
  escalatedAt: Date | null;
  overdue: boolean;
  createdAt: Date;
}

/** The caller's DoctorProfile id, or 403 for a non-doctor. */
async function requireDoctorProfileId(userId: string): Promise<string> {
  return (await doctorsService.getMyDoctorProfile(userId)).id;
}

/**
 * POST /lab-results/:labResultId/acknowledge — the ordering doctor confirms
 * they have looked at an abnormal/critical result. A repeat call is a 409:
 * the first acknowledgement is the record and is never overwritten.
 */
export async function acknowledgeLabResult(actor: AuditActor, labResultId: string) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const doctorProfileId = await requireDoctorProfileId(actor.userId);

  const acknowledgement = await repo.findAcknowledgementForReply(labResultId);
  // Not mine (or no task at all) reads the same as a missing result, so a
  // doctor cannot probe other clinicians' results.
  if (!acknowledgement || acknowledgement.orderingDoctorId !== doctorProfileId) {
    throw new HttpError(404, ACK_REQUIRED_NOT_FOUND);
  }
  if (acknowledgement.acknowledgedAt) {
    throw new HttpError(409, 'This result has already been acknowledged.');
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await repo.acknowledgeLabResultConditional(tx, {
      labResultId,
      orderingDoctorId: doctorProfileId,
      acknowledgedByDoctorId: doctorProfileId,
      now,
    });
    if (!claimed) return null;
    await recordAudit(tx, actor, {
      entityType: 'LabResult',
      entityId: labResultId,
      action: 'lab_result.acknowledged',
      fromState: 'pending',
      toState: 'acknowledged',
      metadata: {
        labOrderId: acknowledgement.labResult.labOrderId,
        severity: acknowledgement.severity,
        // Whether the deadline had already passed when the doctor looked —
        // an escalation that was answered late is a different operational
        // signal from one answered in time.
        escalationDueAt: acknowledgement.escalationDueAt.toISOString(),
        escalatedAt: acknowledgement.escalatedAt?.toISOString() ?? null,
      },
    });
    return tx.labResultAcknowledgement.findUniqueOrThrow({ where: { labResultId } });
  });

  if (!updated) throw new HttpError(409, 'This result has already been acknowledged.');
  return updated;
}

/**
 * GET /lab-results/unacknowledged — the doctor's outstanding tasks, or (for
 * an admin) the escalation queue: everything escalated or past its deadline.
 * `take` is bounded by the caller.
 */
export async function listUnacknowledgedResults(
  actor: AuditActor & { role: Role },
  options: { take: number; now?: Date } = { take: 50 },
) {
  if (!actor.userId) throw new HttpError(401, 'Authentication required.');
  const now = options.now ?? new Date();
  const isAdmin = actor.role === 'admin';
  const orderingDoctorId = isAdmin ? undefined : await requireDoctorProfileId(actor.userId);

  const rows = await repo.listUnacknowledgedResults({
    now,
    take: options.take,
    orderingDoctorId,
    adminEscalationQueue: isAdmin,
  });

  return rows.map(
    (row): UnacknowledgedResultView => ({
      labResultId: row.labResultId,
      labOrderId: row.labResult.labOrderId,
      orderingDoctorId: row.orderingDoctorId,
      severity: row.severity,
      escalationDueAt: row.escalationDueAt,
      escalatedAt: row.escalatedAt,
      overdue: row.escalationDueAt.getTime() <= now.getTime(),
      createdAt: row.createdAt,
    }),
  );
}

/**
 * Escalation sweep (src/jobs/lab-result-escalation.ts). Drains the overdue
 * backlog in bounded pages; a page that makes no progress (every row was
 * acknowledged concurrently) stops the loop. Returns the number escalated.
 */
export async function escalateOverdueResults(
  now = new Date(),
  max = 100,
): Promise<{ escalated: number }> {
  let escalated = 0;
  for (;;) {
    const ids = await repo.listOverdueAcknowledgementIds(now, max);
    if (ids.length === 0) break;
    let progressed = 0;
    for (const id of ids) {
      const didEscalate = await prisma.$transaction(async (tx) => {
        const claimed = await repo.markAcknowledgementEscalated(tx, id, now);
        if (!claimed) return false;
        const row = await tx.labResultAcknowledgement.findUniqueOrThrow({
          where: { id },
          include: { labResult: { select: { labOrderId: true } } },
        });
        await recordAudit(tx, SYSTEM_ACTOR, {
          entityType: 'LabResult',
          entityId: row.labResultId,
          action: 'lab_result.escalated',
          fromState: 'pending',
          toState: 'escalated',
          metadata: {
            labOrderId: row.labResult.labOrderId,
            severity: row.severity,
            escalationDueAt: row.escalationDueAt.toISOString(),
          },
        });
        return true;
      });
      if (didEscalate) progressed += 1;
    }
    escalated += progressed;
    if (ids.length < max || progressed === 0) break;
  }
  return { escalated };
}
