// Pure flag evaluation (issue #132): no I/O, no clock, no randomness, so the
// same (flag, user) always gives the same answer. Anything unexpected is
// "off" — a flag check must never be the reason a request fails.
import { createHash } from 'node:crypto';
import type { Role } from '@prisma/client';

export interface FlagRule {
  enabled: boolean;
  /** 0–100. Compared against the user's sticky bucket. */
  rolloutPercent: number;
  /** Empty = no role restriction. */
  allowRoles: readonly Role[];
  /** Always on for these users (while `enabled`), regardless of role or percentage. */
  allowUserIds: readonly string[];
}

export interface FlagSubject {
  id: string;
  role: Role;
}

/**
 * The user's bucket for a flag, 0–99. Hash-based, so it is the same on every
 * request, every process and every deploy — never random per request. The
 * flag key is part of the hash so that being in the first 10% of one rollout
 * does not mean being in the first 10% of all of them.
 */
export function bucketFor(flagKey: string, userId: string): number {
  const digest = createHash('sha256').update(`${flagKey}:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function evaluateRule(flagKey: string, rule: FlagRule, subject: FlagSubject): boolean {
  try {
    if (!rule.enabled) return false; // kill switch: off for everyone
    if (rule.allowUserIds.includes(subject.id)) return true;
    if (rule.allowRoles.length > 0 && !rule.allowRoles.includes(subject.role)) return false;
    const percent = Number(rule.rolloutPercent);
    if (!Number.isFinite(percent)) return false;
    return bucketFor(flagKey, subject.id) < Math.min(100, Math.max(0, percent));
  } catch {
    return false;
  }
}
