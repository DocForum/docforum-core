import { describe, expect, it } from 'vitest';
import {
  evaluateReferralLoop,
  LoopGuardError,
  REFERRAL_MAX_HOPS,
  type ChainNode,
} from '../../src/modules/referrals/loop';

function node(overrides: Partial<ChainNode> & Pick<ChainNode, 'id'>): ChainNode {
  return {
    referringDoctorId: 'doc-ref',
    targetDoctorId: 'doc-target',
    targetSpecialtyId: null,
    parentReferralId: null,
    ...overrides,
  };
}

const candidate = { referringDoctorId: 'doc-new-referrer', targetDoctorId: 'doc-new-target' };

describe('evaluateReferralLoop', () => {
  it('does not flag a fresh direction with no overlap', () => {
    const ancestors = [node({ id: 'r1', referringDoctorId: 'a', targetDoctorId: 'b' })];
    expect(
      evaluateReferralLoop(ancestors, { ...candidate, targetDoctorId: 'c' }),
    ).toEqual({ flagged: false, reason: null });
  });

  it('flags when the target is an earlier referring doctor (GP return, strict rule)', () => {
    const ancestors = [node({ id: 'r1', referringDoctorId: 'gp', targetDoctorId: 'cardio' })];
    const result = evaluateReferralLoop(ancestors, {
      referringDoctorId: 'cardio',
      targetDoctorId: 'gp',
    });
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain('r1');
  });

  it('flags when the target doctor already appears as a target in the chain', () => {
    const ancestors = [node({ id: 'r1', referringDoctorId: 'a', targetDoctorId: 'cardio' })];
    const result = evaluateReferralLoop(ancestors, {
      referringDoctorId: 'endo',
      targetDoctorId: 'cardio',
    });
    expect(result.flagged).toBe(true);
  });

  it('flags when the target specialty was already visited', () => {
    const ancestors = [
      node({ id: 'r1', referringDoctorId: 'a', targetDoctorId: 'b', targetSpecialtyId: 'spec-cardio' }),
    ];
    const result = evaluateReferralLoop(ancestors, {
      referringDoctorId: 'c',
      targetDoctorId: 'd',
      targetSpecialtyId: 'spec-cardio',
    });
    expect(result.flagged).toBe(true);
    expect(result.reason).toContain('specialty');
  });

  it('throws on self-referral', () => {
    expect(() =>
      evaluateReferralLoop([], { referringDoctorId: 'solo', targetDoctorId: 'solo' }),
    ).toThrow(LoopGuardError);
  });

  it('throws when the chain continues past the walk bound', () => {
    const farthest = node({ id: 'r3', parentReferralId: 'r2-beyond-bound' });
    expect(() => evaluateReferralLoop([node({ id: 'r1' }), node({ id: 'r2' }), farthest], candidate)).toThrow(
      LoopGuardError,
    );
  });

  it('throws when the chain length itself exceeds the hop limit', () => {
    const ancestors = Array.from({ length: REFERRAL_MAX_HOPS }, (_, i) => node({ id: `r${i}` }));
    expect(() => evaluateReferralLoop(ancestors, candidate)).toThrow(LoopGuardError);
  });
});
