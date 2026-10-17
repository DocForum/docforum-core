import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as patientsRepo from '../repositories';
import * as authService from '../../auth/services';

export async function getMyPatientProfile(userId: string) {
  const profile = await patientsRepo.findPatientProfileByUserId(userId);
  // An anonymised profile (issue #41) belongs to a deleted account: every
  // patient route resolves the caller through here, so a still-valid access
  // token stops reaching booking, listing, etc. the moment the account is
  // deleted.
  if (!profile || profile.anonymizedAt) throw new HttpError(404, 'No patient profile for this account.');
  return profile;
}

// --- Account deletion (Phase 8, issue #41, docs/adr/0007) ----------------

/**
 * `DELETE /patients/me`. Anonymises the caller's identity (auth module:
 * User row; this module: PatientProfile) in one transaction and keeps every
 * clinical, order and payment record, per ADR 0007's retention table.
 *
 * Idempotent: an already-deleted account returns `alreadyDeleted: true`
 * without checking the password (it no longer has a usable one) and without
 * touching anything; two concurrent requests anonymise exactly once.
 */
export async function deleteMyAccount(
  userId: string,
  password: string,
  ip?: string | null,
): Promise<{ alreadyDeleted: boolean }> {
  if (await authService.isAccountDeleted(userId)) return { alreadyDeleted: true };
  const profile = await getMyPatientProfile(userId);

  try {
    await authService.confirmPassword(userId, password, ip);
  } catch (err) {
    // A concurrent deletion may have replaced the password between our two
    // checks; that request already did the work, so this one is a no-op.
    if (await authService.isAccountDeleted(userId)) return { alreadyDeleted: true };
    throw err;
  }

  const unusablePasswordHash = await authService.createUnusablePasswordHash();
  const deletedAt = new Date();
  const anonymized = await prisma.$transaction(async (tx) => {
    if (!(await authService.anonymizeAccount(tx, userId, { unusablePasswordHash, deletedAt }))) return false;
    await patientsRepo.anonymizeProfile(tx, profile.id, deletedAt);
    return true;
  });
  return { alreadyDeleted: !anonymized };
}

/** A module that keeps records about a patient which must survive account
 * deletion (ADR 0007). The purge never removes a profile any hold reports
 * true for. Registered in src/retention-holds.ts. */
export interface RetentionHold {
  name: string;
  holds(patientProfileId: string): Promise<boolean>;
}

const retentionHolds = new Map<string, RetentionHold>();

export function registerRetentionHold(hold: RetentionHold): void {
  const existing = retentionHolds.get(hold.name);
  if (existing && existing !== hold) throw new Error(`Retention hold "${hold.name}" is already registered.`);
  retentionHolds.set(hold.name, hold);
}

export function listRetentionHolds(): RetentionHold[] {
  return [...retentionHolds.values()];
}

/**
 * True when a delete was refused by a foreign key that still references the
 * row. Postgres reports `ON DELETE RESTRICT` as SQLSTATE 23001
 * (restrict_violation), which Prisma surfaces as an *unknown* request error
 * rather than P2003 (P2003 is 23503, what NO ACTION raises) — so both shapes
 * are checked.
 */
export function isForeignKeyRefusal(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2003';
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /23001|violates RESTRICT setting of foreign key constraint/.test(err.message);
  }
  return false;
}

export interface PurgeResult {
  purged: number;
  held: number;
  failed: number;
}

/**
 * Scheduled purge (ADR 0007): hard-deletes tombstones only — anonymised
 * patients with no retained records, once the grace period has passed.
 * Clinical, order and payment records are never deleted (their retention
 * period is an open decision). Race-safe: holds are checked first and the
 * RESTRICT foreign keys backstop the delete, so a record created in between
 * makes that one delete fail and the account is simply kept. Re-running is a
 * no-op for everything already purged.
 */
export async function purgeDeletedPatientAccounts(now = new Date()): Promise<PurgeResult> {
  const anonymizedBefore = new Date(now.getTime() - config.accountPurge.graceHours * 60 * 60 * 1000);
  const holds = listRetentionHolds();
  if (holds.length === 0) {
    // Fail closed: with no holds registered (a wiring bug) everything would
    // look purgeable. The RESTRICT FKs would still stop it, but don't try.
    throw new Error('No retention holds registered — refusing to purge.');
  }

  const result: PurgeResult = { purged: 0, held: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    const page = await patientsRepo.findAnonymizedProfilesPage(anonymizedBefore, cursor, 100);
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    for (const profile of page) {
      const held = await Promise.all(holds.map((hold) => hold.holds(profile.id)));
      if (held.some(Boolean)) {
        result.held += 1;
        continue;
      }
      try {
        await prisma.$transaction(async (tx) => {
          if (!(await patientsRepo.deleteAnonymizedProfile(tx, profile.id))) return;
          await authService.purgeAnonymizedAccount(tx, profile.userId);
        });
        result.purged += 1;
      } catch (err) {
        if (isForeignKeyRefusal(err)) {
          // A RESTRICT FK refused: a record exists that no hold reported yet.
          result.held += 1;
        } else {
          result.failed += 1;
          // eslint-disable-next-line no-console
          console.error(`[jobs] account purge failed for one profile: ${err instanceof Error ? err.name : typeof err}`);
        }
      }
    }
    if (page.length < 100) break;
  }
  return result;
}
