// Issue #328: which link is a facility's payee at a given instant.
import { describe, expect, it } from 'vitest';
import { isCancelledWalletLink, selectEffectiveWalletLink } from '../../src/modules/payments/services/wallet-link';

const H = 60 * 60 * 1000;
const t0 = Date.parse('2026-11-01T00:00:00Z');
const at = (hours: number) => new Date(t0 + hours * H);

function link(id: string, created: number, effective: number, replaced: number | null = null) {
  return { id, createdAt: at(created), effectiveAt: at(effective), replacedAt: replaced === null ? null : at(replaced) };
}

describe('selectEffectiveWalletLink', () => {
  // A: first link at 0 (immediate). B: re-link at 10 with a 24h cool-down.
  const A = link('A', 0, 0, 10);
  const B = link('B', 10, 34);

  it('keeps the previous link as payee during the cool-down', () => {
    expect(selectEffectiveWalletLink([A, B], at(10))?.id).toBe('A');
    expect(selectEffectiveWalletLink([A, B], at(33.99))?.id).toBe('A');
  });

  it('switches to the new link exactly when the cool-down ends', () => {
    expect(selectEffectiveWalletLink([A, B], at(34))?.id).toBe('B');
  });

  it('a re-link inside the window cancels the pending link and restarts the window', () => {
    const Bcancelled = link('B', 10, 34, 20); // replaced at 20 < effective 34
    const C = link('C', 20, 44);
    expect(isCancelledWalletLink(Bcancelled)).toBe(true);
    expect(selectEffectiveWalletLink([A, Bcancelled, C], at(35))?.id).toBe('A'); // B never takes effect
    expect(selectEffectiveWalletLink([A, Bcancelled, C], at(44))?.id).toBe('C');
  });

  it('an effective link stays the payee while its replacement cools down', () => {
    const Beffective = link('B', 10, 34, 40); // replaced after it took effect
    const C = link('C', 40, 64);
    expect(isCancelledWalletLink(Beffective)).toBe(false);
    expect(selectEffectiveWalletLink([A, Beffective, C], at(50))?.id).toBe('B');
    expect(selectEffectiveWalletLink([A, Beffective, C], at(64))?.id).toBe('C');
  });

  it('returns null when nothing has taken effect yet', () => {
    expect(selectEffectiveWalletLink([link('P', 0, 24)], at(1))).toBeNull();
    expect(selectEffectiveWalletLink([], at(1))).toBeNull();
  });
});
