import { describe, expect, it } from 'vitest';
import { bucketFor, evaluateRule, type FlagRule } from '../../src/modules/flags/evaluate';

const base: FlagRule = { enabled: true, rolloutPercent: 100, allowRoles: [], allowUserIds: [] };
const patient = { id: 'user-1', role: 'patient' as const };

describe('bucketFor', () => {
  it('is sticky: same flag + user is always the same bucket, in 0..99', () => {
    const first = bucketFor('payments.wallet_funding', 'user-1');
    for (let i = 0; i < 50; i++) expect(bucketFor('payments.wallet_funding', 'user-1')).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(100);
  });

  it('is independent per flag: the same user is not in the same slice of every rollout', () => {
    const differing = Array.from({ length: 200 }, (_, i) => `u${i}`).filter(
      (id) => bucketFor('flag.a', id) !== bucketFor('flag.b', id),
    );
    expect(differing.length).toBeGreaterThan(150);
  });

  it('spreads users roughly evenly', () => {
    const n = 10_000;
    let below50 = 0;
    for (let i = 0; i < n; i++) if (bucketFor('flag.spread', `user-${i}`) < 50) below50++;
    expect(below50 / n).toBeGreaterThan(0.47);
    expect(below50 / n).toBeLessThan(0.53);
  });
});

describe('evaluateRule', () => {
  it('is off when the flag is disabled, whatever else is set (kill switch)', () => {
    expect(evaluateRule('f', { ...base, enabled: false }, patient)).toBe(false);
    expect(evaluateRule('f', { ...base, enabled: false, allowUserIds: ['user-1'] }, patient)).toBe(false);
  });

  it('0% is off for everyone and 100% is on for everyone', () => {
    for (let i = 0; i < 200; i++) {
      const user = { id: `user-${i}`, role: 'patient' as const };
      expect(evaluateRule('f', { ...base, rolloutPercent: 0 }, user)).toBe(false);
      expect(evaluateRule('f', { ...base, rolloutPercent: 100 }, user)).toBe(true);
    }
  });

  it('a percentage rollout is sticky and grows monotonically: raising it never turns anyone off', () => {
    const users = Array.from({ length: 2000 }, (_, i) => ({ id: `user-${i}`, role: 'patient' as const }));
    const at = (percent: number) => users.filter((u) => evaluateRule('f', { ...base, rolloutPercent: percent }, u)).map((u) => u.id);
    const ten = new Set(at(10));
    const fifty = new Set(at(50));
    expect(at(10)).toEqual([...ten]); // same answer on a second pass
    for (const id of ten) expect(fifty.has(id)).toBe(true);
    expect(ten.size).toBeGreaterThan(120);
    expect(ten.size).toBeLessThan(280);
  });

  it('role targeting restricts eligibility; an allowlisted user id bypasses it', () => {
    const doctorsOnly: FlagRule = { ...base, allowRoles: ['doctor'] };
    expect(evaluateRule('f', doctorsOnly, patient)).toBe(false);
    expect(evaluateRule('f', doctorsOnly, { id: 'doc-1', role: 'doctor' })).toBe(true);
    expect(evaluateRule('f', { ...doctorsOnly, allowUserIds: ['user-1'] }, patient)).toBe(true);
  });

  it('an allowlisted user is on even at 0%', () => {
    expect(evaluateRule('f', { ...base, rolloutPercent: 0, allowUserIds: ['user-1'] }, patient)).toBe(true);
  });

  it('never throws: malformed rules read as off', () => {
    expect(evaluateRule('f', { ...base, rolloutPercent: Number.NaN }, patient)).toBe(false);
    expect(evaluateRule('f', null as unknown as FlagRule, patient)).toBe(false);
    expect(evaluateRule('f', { ...base, allowUserIds: undefined as unknown as string[] }, patient)).toBe(false);
  });
});
