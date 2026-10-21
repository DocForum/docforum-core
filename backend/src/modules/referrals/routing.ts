// Specialty-only referral routing (issue #6, docs/adr/0008).
//
// The rule itself is a pure function over (doctor, active-load) pairs so
// it can be asserted exactly in unit tests without a database: lowest
// count of *active* (pending/accepted) referrals first, ties broken by
// doctorProfileId so the same candidate set always yields the same
// choice. Everything that touches the database (eligibility, counts)
// stays in services/repositories.
export interface RoutingCandidate {
  doctorProfileId: string;
  /** Referrals currently targeted at this doctor in a non-terminal state. */
  activeReferralCount: number;
}

/**
 * Least-loaded choice, or null when there is nobody eligible. Null is a
 * real outcome (zero verified doctors in the specialty) — callers turn it
 * into a 422; no referral is ever created without a target.
 */
export function selectLeastLoaded(candidates: RoutingCandidate[]): RoutingCandidate | null {
  let best: RoutingCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.activeReferralCount < best.activeReferralCount) {
      best = candidate;
      continue;
    }
    // Equal load: deterministic tie-break so routing is reproducible and
    // testable. Doctor ids are UUIDs, so this is arbitrary but stable.
    if (candidate.activeReferralCount === best.activeReferralCount && candidate.doctorProfileId < best.doctorProfileId) {
      best = candidate;
    }
  }
  return best;
}
