// users repositories — placeholder. Data access only. Not to be imported
// by other modules directly — go through services/ instead.
//
// Phase 8 (issue #39): this module owns the shared `User` row and admin
// account lifecycle (invites, deactivation). `auth` still owns credentials
// and sessions — it calls into these services for user creation, never the
// other way round.
import { prisma } from '../../../db/prisma-client';
import type { Prisma, Role } from '@prisma/client';
import * as auditService from '../../audit/services';

type Db = typeof prisma | Prisma.TransactionClient;

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

/** Active = not deactivated. Used for the "last active admin" guard. */
export function countActiveUsersByRole(role: Role) {
  return prisma.user.count({ where: { role, deactivatedAt: null } });
}

export interface AdminUserQuery {
  role?: Role;
  state?: 'active' | 'deactivated' | 'deleted';
  emailPrefix?: string;
  /** Keyset position: return accounts strictly older than this one. */
  before?: { createdAt: Date; id: string };
  take: number;
}

/**
 * One keyset page of the admin account directory (issue #275).
 *
 * The selection is the whole point: account-level fields only. Credentials
 * (`passwordHash`, `tokenVersion`), TOTP secrets and every clinical relation
 * are deliberately not selectable here, so a future controller change can't
 * accidentally widen the response.
 */
export function findAdminUsersPage(query: AdminUserQuery) {
  const where: Prisma.UserWhereInput = {};
  if (query.role) where.role = query.role;
  if (query.state === 'active') {
    where.deactivatedAt = null;
    where.deletedAt = null;
  } else if (query.state === 'deactivated') {
    where.deactivatedAt = { not: null };
    where.deletedAt = null;
  } else if (query.state === 'deleted') {
    where.deletedAt = { not: null };
  }
  if (query.emailPrefix) where.email = { startsWith: query.emailPrefix };
  if (query.before) {
    where.OR = [
      { createdAt: { lt: query.before.createdAt } },
      { createdAt: query.before.createdAt, id: { lt: query.before.id } },
    ];
  }
  return prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      role: true,
      locale: true,
      emailVerifiedAt: true,
      deactivatedAt: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.take,
  });
}

export function setUserDeactivated(userId: string, deactivatedAt: Date) {
  return prisma.user.update({
    where: { id: userId },
    data: { deactivatedAt, sessionsInvalidatedAt: deactivatedAt },
  });
}

export function setUserReactivated(userId: string, at: Date) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      deactivatedAt: null,
      // Also bumped on reactivation: tokens issued before deactivation must
      // not come back to life because the account was re-enabled.
      sessionsInvalidatedAt: at,
    },
  });
}

// --- Admin invites (Phase 8, issue #39) ----------------------------------

/** Creates the invite and retires any outstanding invite for the same
 * address, in one transaction — issuing a new link shouldn't leave two live
 * ones. Retiring means setting `consumedAt`, never deleting. */
export function replaceAdminInvite(
  input: {
    email: string;
    tokenHash: string;
    expiresAt: Date;
    invitedByUserId: string;
  },
  actor?: auditService.AuditActor,
) {
  return prisma.$transaction(async (tx) => {
    await tx.adminInvite.updateMany({
      where: { email: input.email, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const invite = await tx.adminInvite.create({
      data: {
        email: input.email,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        invitedByUserId: input.invitedByUserId,
      },
    });
    if (actor) {
      await auditService.record(tx, actor, {
        entityType: 'AdminInvite',
        entityId: invite.id,
        action: 'admin_invite.created',
        fromState: null,
        toState: 'pending',
      });
    }
    return invite;
  });
}

export function findAdminInviteByTokenHash(tokenHash: string) {
  return prisma.adminInvite.findUnique({ where: { tokenHash } });
}

export function findAdminInviteById(id: string, db: Db = prisma) {
  return db.adminInvite.findUnique({ where: { id } });
}

export interface AdminInviteQuery {
  status: 'pending' | 'redeemed' | 'expired' | 'revoked';
  now: Date;
  /** Keyset position: return invites strictly older than this one. */
  before?: { createdAt: Date; id: string };
  take: number;
}

/** One keyset page of admin invites, newest first, with the token hash
 * deliberately absent from the selection — it must never leave the module. */
export function findAdminInvitesPage(query: AdminInviteQuery) {
  const where: Prisma.AdminInviteWhereInput = {};
  if (query.status === 'pending') {
    where.consumedAt = null;
    where.revokedAt = null;
    where.expiresAt = { gt: query.now };
  } else if (query.status === 'expired') {
    where.consumedAt = null;
    where.revokedAt = null;
    where.expiresAt = { lte: query.now };
  } else if (query.status === 'redeemed') {
    where.consumedAt = { not: null };
  } else {
    where.revokedAt = { not: null };
  }
  if (query.before) {
    where.OR = [
      { createdAt: { lt: query.before.createdAt } },
      { createdAt: query.before.createdAt, id: { lt: query.before.id } },
    ];
  }
  return prisma.adminInvite.findMany({
    where,
    select: {
      id: true,
      email: true,
      expiresAt: true,
      consumedAt: true,
      revokedAt: true,
      invitedByUserId: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.take,
  });
}

/** Revokes an invite atomically, only while it is neither redeemed nor
 * already revoked. Returns the number of rows changed (0 = lost the race or
 * not revocable), so the caller can distinguish 409 from success. */
export function revokeAdminInviteIfUsable(tx: Prisma.TransactionClient, id: string, revokedAt: Date) {
  return tx.adminInvite.updateMany({
    where: { id, consumedAt: null, revokedAt: null },
    data: { revokedAt },
  });
}

/** Retention prune (issue #276): deletes up to `batchSize` invites whose
 * expiry, consumption or revocation is older than `cutoff`. A live invite
 * (unexpired and unconsumed) never matches. Raw SQL because Prisma cannot
 * express `DELETE ... LIMIT`; the bounded batch keeps locks short. */
export function pruneExpiredAdminInvites(options: { cutoff: Date; batchSize: number }) {
  return prisma.$executeRaw`
    DELETE FROM "AdminInvite"
    WHERE "id" IN (
      SELECT "id" FROM "AdminInvite"
      WHERE "expiresAt" < ${options.cutoff}
         OR ("consumedAt" IS NOT NULL AND "consumedAt" < ${options.cutoff})
         OR ("revokedAt" IS NOT NULL AND "revokedAt" < ${options.cutoff})
      ORDER BY "expiresAt" ASC
      LIMIT ${options.batchSize}
    )
  `;
}

/** Consumes the invite and creates the admin account atomically: a
 * consumed invite with no account (or an account from an already-consumed
 * invite) must never be observable. Returns null if the invite was already
 * consumed by a concurrent redemption — see services/redeemAdminInvite.
 *
 * TODO(issue #34): when email verification lands, an invited/bootstrapped
 * admin should be created already verified — an invite is an admin-vouched
 * address, and there is no email provider to verify against until issue
 * #17. The `emailVerifiedAt` column doesn't exist on this branch, so it
 * can't be set here yet; wire it up in the PR that merges both. */
export function consumeAdminInviteAndCreateAdmin(input: {
  inviteId: string;
  email: string;
  passwordHash: string;
  consumedAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    // Issue #277: a revoked invite is never redeemable. This conditional
    // update and revokeAdminInviteIfUsable are the two writers of the same
    // row, so under a race exactly one of them changes it.
    const consumed = await tx.adminInvite.updateMany({
      where: { id: input.inviteId, consumedAt: null, revokedAt: null },
      data: { consumedAt: input.consumedAt },
    });
    if (consumed.count !== 1) return null;

    return tx.user.create({
      data: {
        email: input.email,
        passwordHash: input.passwordHash,
        role: 'admin',
      },
    });
  });
}
