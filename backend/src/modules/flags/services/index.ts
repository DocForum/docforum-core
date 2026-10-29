// Feature flags (Phase 8, issue #132). The only exported surface of this
// module: other modules ask `isEnabled`, the controllers call the rest.
//
// Evaluation never throws and defaults to off: an unknown flag, a database
// outage with nothing cached, or a malformed row all read as "off". With a
// stale cache and the database down, the stale values keep being served.
import type { Role } from '@prisma/client';
import { config } from '../../../config';
import { prisma } from '../../../db/prisma-client';
import * as auditService from '../../audit/services';
import * as flagsRepo from '../repositories';
import { evaluateRule, type FlagRule, type FlagSubject } from '../evaluate';

/** ADR 0005: the patient-wallet funding mode, the first flag user. */
export const WALLET_FUNDING_FLAG = 'payments.wallet_funding';

export interface FeatureFlagView extends FlagRule {
  key: string;
  description: string;
  updatedAt: Date;
}

export interface FlagPatch {
  description?: string;
  enabled?: boolean;
  rolloutPercent?: number;
  allowRoles?: Role[];
  allowUserIds?: string[];
}

let cache: { loadedAt: number; flags: Map<string, FeatureFlagView> } | null = null;

/** Drop the in-memory copy (an admin change in this process, or a test). */
export function invalidateFlagCache(): void {
  cache = null;
}

async function loadFlags(now = Date.now()): Promise<Map<string, FeatureFlagView>> {
  const ttlMs = config.featureFlags.cacheTtlSeconds * 1000;
  if (cache && now - cache.loadedAt < ttlMs) return cache.flags;
  try {
    const rows = await flagsRepo.listFlags();
    const flags = new Map<string, FeatureFlagView>();
    for (const row of rows) {
      flags.set(row.key, {
        key: row.key,
        description: row.description,
        enabled: row.enabled,
        rolloutPercent: row.rolloutPercent,
        allowRoles: row.allowRoles,
        allowUserIds: row.allowUserIds,
        updatedAt: row.updatedAt,
      });
    }
    cache = { loadedAt: now, flags };
    return flags;
  } catch {
    // Keep serving what we had, and retry in a second rather than on every call.
    if (cache) {
      cache = { loadedAt: now - ttlMs + 1000, flags: cache.flags };
      return cache.flags;
    }
    return new Map();
  }
}

/** Is `key` on for this user? Never throws; false for anything unknown. */
export async function isEnabled(key: string, subject: FlagSubject): Promise<boolean> {
  try {
    const flag = (await loadFlags()).get(key);
    return flag ? evaluateRule(key, flag, subject) : false;
  } catch {
    return false;
  }
}

/** Every known flag, evaluated for this user — the body of `GET /me/flags`. */
export async function evaluateAllFor(subject: FlagSubject): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  try {
    for (const flag of (await loadFlags()).values()) {
      result[flag.key] = evaluateRule(flag.key, flag, subject);
    }
  } catch {
    // fall through with whatever was evaluated: unlisted = off
  }
  return result;
}

// --- Admin ---------------------------------------------------------------

export async function listFlagsForAdmin(): Promise<FeatureFlagView[]> {
  // Straight from the database, not the cache: an admin screen must show truth.
  const rows = await flagsRepo.listFlags();
  return rows.map((row) => ({
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    rolloutPercent: row.rolloutPercent,
    allowRoles: row.allowRoles,
    allowUserIds: row.allowUserIds,
    updatedAt: row.updatedAt,
  }));
}

/**
 * Create or update a flag and record the change in the same transaction
 * (`feature_flag.updated`). Metadata carries only counts and the percentage —
 * never the allowlisted user ids themselves.
 */
export async function updateFlag(actor: auditService.AuditActor, key: string, patch: FlagPatch): Promise<FeatureFlagView> {
  const saved = await prisma.$transaction(async (tx) => {
    const before = await flagsRepo.findFlag(tx, key);
    const next = {
      description: patch.description ?? before?.description ?? '',
      enabled: patch.enabled ?? before?.enabled ?? false,
      rolloutPercent: patch.rolloutPercent ?? before?.rolloutPercent ?? 100,
      allowRoles: patch.allowRoles ?? before?.allowRoles ?? [],
      allowUserIds: patch.allowUserIds ?? before?.allowUserIds ?? [],
    };
    const row = await flagsRepo.upsertFlag(tx, key, next);
    await auditService.record(tx, actor, {
      entityType: 'FeatureFlag',
      entityId: key,
      action: before ? 'feature_flag.updated' : 'feature_flag.created',
      fromState: before ? (before.enabled ? 'enabled' : 'disabled') : null,
      toState: next.enabled ? 'enabled' : 'disabled',
      metadata: {
        rolloutPercent: next.rolloutPercent,
        previousRolloutPercent: before?.rolloutPercent ?? null,
        allowRoleCount: next.allowRoles.length,
        allowUserCount: next.allowUserIds.length,
      },
    });
    return row;
  });
  invalidateFlagCache();
  return {
    key: saved.key,
    description: saved.description,
    enabled: saved.enabled,
    rolloutPercent: saved.rolloutPercent,
    allowRoles: saved.allowRoles,
    allowUserIds: saved.allowUserIds,
    updatedAt: saved.updatedAt,
  };
}
