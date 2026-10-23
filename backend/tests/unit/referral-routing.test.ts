import { describe, expect, it } from 'vitest';
import { selectLeastLoaded } from '../../src/modules/referrals/routing';

// Issue #6 / docs/adr/0008: the specialty-only routing rule is a pure
// selection over (doctor, active-load) pairs, so it can be asserted
// exactly here without a database. The end-to-end behaviour (eligibility,
// zero candidates, batch exclusions) is covered in
// tests/integration/referral-routing.test.mts.
describe('referral routing — least-loaded selection', () => {
  it('returns null when nobody is eligible', () => {
    expect(selectLeastLoaded([])).toBeNull();
  });

  it('picks the single eligible candidate', () => {
    expect(selectLeastLoaded([{ doctorProfileId: 'doctor-a', activeReferralCount: 7 }])).toEqual({
      doctorProfileId: 'doctor-a',
      activeReferralCount: 7,
    });
  });

  it('picks the doctor with the fewest active referrals, regardless of input order', () => {
    const candidates = [
      { doctorProfileId: 'doctor-a', activeReferralCount: 3 },
      { doctorProfileId: 'doctor-b', activeReferralCount: 0 },
      { doctorProfileId: 'doctor-c', activeReferralCount: 1 },
    ];
    expect(selectLeastLoaded(candidates)?.doctorProfileId).toBe('doctor-b');
    expect(selectLeastLoaded([...candidates].reverse())?.doctorProfileId).toBe('doctor-b');
  });

  it('is deterministic on ties: lowest doctorProfileId wins', () => {
    const candidates = [
      { doctorProfileId: 'ffff', activeReferralCount: 2 },
      { doctorProfileId: '0000', activeReferralCount: 2 },
      { doctorProfileId: 'aaaa', activeReferralCount: 2 },
    ];
    expect(selectLeastLoaded(candidates)?.doctorProfileId).toBe('0000');
    expect(selectLeastLoaded([...candidates].reverse())?.doctorProfileId).toBe('0000');
  });

  it('does not mutate its input', () => {
    const candidates = [
      { doctorProfileId: 'doctor-a', activeReferralCount: 1 },
      { doctorProfileId: 'doctor-b', activeReferralCount: 0 },
    ];
    const snapshot = candidates.map((candidate) => ({ ...candidate }));
    selectLeastLoaded(candidates);
    expect(candidates).toEqual(snapshot);
  });
});
