// Issue #65 / PRD §8.1.2: pure loop-chain evaluation, kept free of Prisma
// so it can be unit-tested without a database. The SQL walk lives in
// referrals/repositories; this decides what the walk's output means.
//
// STRICT rule (chosen deliberately over a "return to the GP is fine"
// exception): a referral whose target doctor OR target specialty already
// appears ANYWHERE in the ancestor chain is flagged — including the
// original referring GP. A human on the admin queue decides whether the
// repeat is clinically legitimate; the system never silently allows a
// bounce and never hard-blocks a possibly-legitimate one.

/** One ancestor referral in the chain, nearest-first. */
export interface ChainNode {
  id: string;
  referringDoctorId: string;
  targetDoctorId: string | null;
  targetSpecialtyId: string | null;
  /** Non-null means the chain continues further back. */
  parentReferralId: string | null;
}

export interface LoopEvaluation {
  flagged: boolean;
  reason: string | null;
}

/**
 * Maximum number of referrals allowed in one lineage chain, INCLUDING the
 * one being created. Bounded so the CTE walk is bounded (hard rule: no
 * unbounded recursion) and so an endlessly bouncing patient hits a wall
 * a human can see. Env-overridable; 4 is a boring v1 default.
 */
export const REFERRAL_MAX_HOPS = (() => {
  const fromEnv = Number(process.env.REFERRAL_MAX_HOPS);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 4;
})();

/**
 * Decides whether a candidate referral is a loop.
 *
 * Throws (caller maps to 422) when:
 *  - the candidate targets its own referring doctor (self-referral), or
 *  - the ancestor chain is longer than the hop limit allows.
 *
 * Returns `{ flagged, reason }` otherwise: flagged referrals are still
 * created — they surface in the admin queue with the reason attached.
 */
export function evaluateReferralLoop(
  ancestors: ChainNode[],
  candidate: { referringDoctorId: string; targetDoctorId: string; targetSpecialtyId?: string | null },
): LoopEvaluation {
  if (candidate.targetDoctorId === candidate.referringDoctorId) {
    throw new LoopGuardError('A doctor cannot refer a patient to themselves.');
  }

  // ancestors is bounded by the CTE at REFERRAL_MAX_HOPS - 1 nodes; if
  // the farthest one still has a parent, the real chain is longer.
  const farthest = ancestors[ancestors.length - 1];
  if (farthest && farthest.parentReferralId !== null) {
    throw new LoopGuardError(
      `Referral chain exceeds the maximum of ${REFERRAL_MAX_HOPS} hops; escalate to a human.`,
    );
  }
  if (ancestors.length + 1 > REFERRAL_MAX_HOPS) {
    throw new LoopGuardError(
      `Referral chain exceeds the maximum of ${REFERRAL_MAX_HOPS} hops; escalate to a human.`,
    );
  }

  for (const ancestor of ancestors) {
    if (ancestor.targetDoctorId && ancestor.targetDoctorId === candidate.targetDoctorId) {
      return {
        flagged: true,
        reason: `Target doctor already appears in referral chain (referral ${ancestor.id}).`,
      };
    }
    if (ancestor.referringDoctorId === candidate.targetDoctorId) {
      return {
        flagged: true,
        reason: `Target is the referring doctor of an earlier referral in the chain (referral ${ancestor.id}).`,
      };
    }
    if (
      candidate.targetSpecialtyId &&
      ancestor.targetSpecialtyId &&
      ancestor.targetSpecialtyId === candidate.targetSpecialtyId
    ) {
      return {
        flagged: true,
        reason: `Target specialty already visited in referral chain (referral ${ancestor.id}).`,
      };
    }
  }

  return { flagged: false, reason: null };
}

/** Thrown by evaluateReferralLoop for hard rejections (not flag-worthy). */
export class LoopGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopGuardError';
  }
}
