// users services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module. See AGENTS.md "Non-negotiable rules".
//
// Phase 8 (issue #39): admin account lifecycle — invites and deactivation.
import { config } from '../../../config';
import { prisma } from '../../../db/prisma-client';
import { HttpError } from '../../../http-error';
import * as auditService from '../../audit/services';
import type { AuditActor } from '../../audit/services';
import * as usersRepo from '../repositories';
import { generateAdminInviteToken, hashAdminInviteToken } from './invite-tokens';
import type { Role } from '@prisma/client';

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  locale: string;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type UserRow = {
  id: string;
  email: string;
  role: Role;
  locale: string;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    locale: user.locale,
    deactivatedAt: user.deactivatedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

// --- Invites -------------------------------------------------------------

export interface CreateAdminInviteInput {
  email: string;
  invitedByUserId: string;
}

export interface CreatedAdminInvite {
  id: string;
  email: string;
  expiresAt: Date;
  /**
   * The raw invite token, returned exactly once — only its hash is stored,
   * so it can never be retrieved again. There is no email provider yet
   * (issue #17), so the inviting admin has to pass the link on out of band;
   * both are deliberately never written to a log.
   */
  token: string;
  inviteUrl: string;
}

export async function createAdminInvite(
  input: CreateAdminInviteInput,
  actor?: AuditActor,
): Promise<CreatedAdminInvite> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw new HttpError('EMAIL_REQUIRED', 'An email address is required.');

  const existing = await usersRepo.findUserByEmail(email);
  if (existing) {
    // Deliberately not "an account exists": that's already visible from the
    // signup endpoint, and an admin inviting a colleague needs the real
    // reason rather than a coin flip. Refusing here keeps the invite table
    // to addresses that can actually be redeemed.
    throw new HttpError('EMAIL_TAKEN', 'An account with this email already exists — deactivate or promote it instead of inviting it.');
  }

  const token = generateAdminInviteToken();
  const expiresAt = new Date(Date.now() + config.adminInvites.ttlHours * 60 * 60 * 1000);
  const invite = await usersRepo.replaceAdminInvite({
    email,
    tokenHash: hashAdminInviteToken(token),
    expiresAt,
    invitedByUserId: input.invitedByUserId,
  }, actor);

  return {
    id: invite.id,
    email: invite.email,
    expiresAt: invite.expiresAt,
    token,
    inviteUrl: `${config.adminInvites.acceptUrl}?token=${encodeURIComponent(token)}`,
  };
}

// --- Admin invite administration (Phase 8, issue #277) -------------------

export type AdminInviteStatus = 'pending' | 'redeemed' | 'expired' | 'revoked';

export interface AdminInviteSummary {
  id: string;
  email: string;
  status: AdminInviteStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  invitedByUserId: string;
  createdAt: Date;
}

type AdminInviteRow = {
  id: string;
  email: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  invitedByUserId: string;
  createdAt: Date;
};

/** Revocation wins over redemption and expiry in the derived label: a
 * consumed+revoked row cannot exist (the two writes are mutually
 * conditional), so this ordering is just defensive. */
function inviteStatus(invite: AdminInviteRow, now: Date): AdminInviteStatus {
  if (invite.revokedAt) return 'revoked';
  if (invite.consumedAt) return 'redeemed';
  return invite.expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
}

function toAdminInviteSummary(invite: AdminInviteRow, now: Date): AdminInviteSummary {
  return {
    id: invite.id,
    email: invite.email,
    status: inviteStatus(invite, now),
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt,
    revokedAt: invite.revokedAt,
    invitedByUserId: invite.invitedByUserId,
    createdAt: invite.createdAt,
  };
}

/** Opaque keyset cursor, same encoding as the audit list: base64url of
 * "<createdAt ISO>|<id>" of the last item on the page. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator < 1 || Number.isNaN(createdAt.getTime()) || !id) {
    throw new HttpError('INVALID_CURSOR', 'Invalid cursor.');
  }
  return { createdAt, id };
}

export interface ListAdminInvitesInput {
  status: AdminInviteStatus;
  cursor?: string;
  limit: number;
}

/** Lists invites by derived status. Token hashes are never selected, let
 * alone returned — the raw token only ever exists once, in the creation
 * response (issue #39). */
export async function listAdminInvites(input: ListAdminInvitesInput) {
  const now = new Date();
  const rows = await usersRepo.findAdminInvitesPage({
    status: input.status,
    now,
    before: input.cursor ? decodeCursor(input.cursor) : undefined,
    // One extra row tells us whether there is a next page without a count.
    take: input.limit + 1,
  });
  const items = rows.slice(0, input.limit).map((row) => toAdminInviteSummary(row, now));
  const last = rows.length > input.limit ? rows[input.limit - 1] : undefined;
  return { items, nextCursor: last ? encodeCursor(last) : null };
}

export interface RevokeAdminInviteResult {
  invite: AdminInviteSummary;
  /** True when the invite was already revoked, so no second audit event was
   * written. Revocation is idempotent; redemption is not. */
  alreadyRevoked: boolean;
}

/**
 * Revokes an invite so it can never be redeemed (issue #277).
 *
 * Revocation and redemption are both conditional UPDATEs on the same row:
 * redemption requires `consumedAt IS NULL AND revokedAt IS NULL`, revocation
 * requires the same pair. Whichever commits first wins; the loser sees 0 rows
 * and surfaces a 409, so a revoked invite cannot be redeemed and a redeemed
 * one cannot be revoked. The audit event is written in the same transaction
 * as the revocation.
 */
export async function revokeAdminInvite(
  actor: auditService.AuditActor,
  inviteId: string,
): Promise<RevokeAdminInviteResult> {
  return prisma.$transaction(async (tx) => {
    const invite = await usersRepo.findAdminInviteById(inviteId, tx);
    if (!invite) throw new HttpError('ADMIN_INVITE_NOT_FOUND', 'Admin invite not found.');
    if (invite.consumedAt) {
      throw new HttpError('ADMIN_INVITE_REDEEMED', 'This invite has already been redeemed and cannot be revoked.');
    }
    if (invite.revokedAt) {
      return { invite: toAdminInviteSummary(invite, new Date()), alreadyRevoked: true };
    }

    const revokedAt = new Date();
    const result = await usersRepo.revokeAdminInviteIfUsable(tx, inviteId, revokedAt);
    if (result.count !== 1) {
      // Lost the race with a redemption or another revocation. Re-read under
      // the same transaction so the caller gets the truthful reason.
      const current = await usersRepo.findAdminInviteById(inviteId, tx);
      if (!current) throw new HttpError('ADMIN_INVITE_NOT_FOUND', 'Admin invite not found.');
      if (current.consumedAt) {
        throw new HttpError('ADMIN_INVITE_REDEEMED', 'This invite has already been redeemed and cannot be revoked.');
      }
      return { invite: toAdminInviteSummary(current, new Date()), alreadyRevoked: true };
    }

    await auditService.record(tx, actor, {
      entityType: 'AdminInvite',
      entityId: inviteId,
      action: 'admin_invite.revoked',
      fromState: 'pending',
      toState: 'revoked',
      // Ids only — the invited address itself is personal data and stays
      // out of the audit trail.
      metadata: { invitedByUserId: invite.invitedByUserId },
    });

    return { invite: toAdminInviteSummary({ ...invite, revokedAt }, new Date()), alreadyRevoked: false };
  });
}

// --- Admin account directory (Phase 8, issue #275) -----------------------

export interface AdminUserSummary {
  id: string;
  /** Null for a deleted (tombstoned) account: its stored address is a
   * `deleted+<id>@deleted.invalid` placeholder, not a real address. */
  email: string | null;
  role: Role;
  locale: string;
  emailVerifiedAt: Date | null;
  deactivatedAt: Date | null;
  deletedAt: Date | null;
  /** Explicit flag so a console never has to infer tombstones from a null
   * email or an address pattern. */
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListAdminUsersInput {
  role?: Role;
  state?: 'active' | 'deactivated' | 'deleted';
  emailPrefix?: string;
  cursor?: string;
  limit: number;
}

/** Read-only account directory for admin support work (issue #275).
 * Account-level fields only — no credentials, no tokens, no clinical data. */
export async function listAdminUsers(input: ListAdminUsersInput) {
  const rows = await usersRepo.findAdminUsersPage({
    role: input.role,
    state: input.state,
    emailPrefix: input.emailPrefix,
    before: input.cursor ? decodeCursor(input.cursor) : undefined,
    take: input.limit + 1,
  });
  const items: AdminUserSummary[] = rows.slice(0, input.limit).map((row) => ({
    id: row.id,
    email: row.deletedAt ? null : row.email,
    role: row.role,
    locale: row.locale,
    emailVerifiedAt: row.emailVerifiedAt,
    deactivatedAt: row.deactivatedAt,
    deletedAt: row.deletedAt,
    deleted: Boolean(row.deletedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const last = rows.length > input.limit ? rows[input.limit - 1] : undefined;
  return { items, nextCursor: last ? encodeCursor(last) : null };
}

export interface RedeemAdminInviteInput {
  token: string;
  email: string;
  passwordHash: string;
}

/** Called by the auth module's `POST /auth/signup-with-invite` — the invite
 * is the users module's business, the session is auth's. Returns the created
 * admin account, or throws a 400/403 that says nothing about which invite
 * tokens exist beyond "this one isn't usable". */
export async function redeemAdminInvite(input: RedeemAdminInviteInput): Promise<PublicUser> {
  const invite = await usersRepo.findAdminInviteByTokenHash(hashAdminInviteToken(input.token));
  if (!invite) throw new HttpError('INVALID_ADMIN_INVITE', 'Invalid admin invite token.');
  if (invite.revokedAt) {
    throw new HttpError('ADMIN_INVITE_REVOKED', 'This invite has been revoked. Ask an admin for a new one.');
  }
  if (invite.consumedAt) throw new HttpError('ADMIN_INVITE_ALREADY_USED', 'This invite has already been used.');
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new HttpError('ADMIN_INVITE_EXPIRED', 'This invite has expired. Ask an admin for a new one.');
  }
  if (invite.email.toLowerCase() !== input.email.trim().toLowerCase()) {
    throw new HttpError('ADMIN_INVITE_EMAIL_MISMATCH', 'This invite was issued for a different email address.');
  }

  const user = await usersRepo.consumeAdminInviteAndCreateAdmin({
    inviteId: invite.id,
    email: input.email.trim().toLowerCase(),
    passwordHash: input.passwordHash,
    consumedAt: new Date(),
  });

  // Lost a race with a concurrent redemption of the same invite.
  if (!user) throw new HttpError('ADMIN_INVITE_ALREADY_USED', 'This invite has already been used.');

  return toPublicUser(user);
}

// --- Retention (Phase 8, issue #276) -------------------------------------

/** Deletes admin invites that expired, were redeemed, or were revoked more
 * than the grace period ago. A live, unredeemed invite never matches. */
export function pruneExpiredAdminInvites(options: { now?: Date; batchSize?: number } = {}): Promise<number> {
  const now = options.now ?? new Date();
  return usersRepo.pruneExpiredAdminInvites({
    cutoff: new Date(now.getTime() - config.tokenPrune.graceHours * 60 * 60 * 1000),
    batchSize: options.batchSize ?? config.tokenPrune.batchSize,
  });
}

// --- Deactivation --------------------------------------------------------

export interface DeactivateInput {
  userId: string;
}

/**
 * Deactivates an account: it can no longer log in, refresh, or use an
 * existing access token (see auth's `assertActiveSession`).
 *
 * Nothing is deleted. No clinical or payment record is keyed to this flag,
 * and this function only ever writes `deactivatedAt` /
 * `sessionsInvalidatedAt` — that's the whole point of a soft deactivation
 * (AGENTS.md hard rules on append-only/mutability of order records).
 */
export async function deactivateUser(input: DeactivateInput, actor?: AuditActor): Promise<PublicUser> {
  return prisma.$transaction(async (tx) => {
    // Lock all active admin rows ordered by id to prevent deadlocks and prevent
    // two concurrent admin deactivations from both observing activeAdmins > 1.
    await tx.$queryRaw`SELECT id FROM "User" WHERE role = 'admin'::"Role" AND "deactivatedAt" IS NULL ORDER BY id FOR UPDATE`;

    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new HttpError('USER_NOT_FOUND', 'User not found.');
    if (user.deactivatedAt) return toPublicUser(user); // idempotent: no audit event

    // The admin console is the only way back in, so the last active admin
    // must not be able to lock everyone out of it (explicit in issue #39 / #274).
    if (user.role === 'admin') {
      const activeAdmins = await tx.user.count({ where: { role: 'admin', deactivatedAt: null } });
      if (activeAdmins <= 1) {
        throw new HttpError('LAST_ADMIN_CANNOT_DEACTIVATE', 'Cannot deactivate the last active admin.');
      }
    }

    const now = new Date();
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { deactivatedAt: now, sessionsInvalidatedAt: now },
    });

    if (actor) {
      await auditService.record(tx, actor, {
        entityType: 'User',
        entityId: user.id,
        action: 'user.deactivated',
        fromState: 'active',
        toState: 'deactivated',
      });
    }

    return toPublicUser(updated);
  });
}

export async function reactivateUser(input: DeactivateInput, actor?: AuditActor): Promise<PublicUser> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) throw new HttpError('USER_NOT_FOUND', 'User not found.');
    if (!user.deactivatedAt) return toPublicUser(user); // idempotent: no audit event

    const now = new Date();
    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        deactivatedAt: null,
        // Also bumped on reactivation: tokens issued before deactivation must
        // not come back to life because the account was re-enabled.
        sessionsInvalidatedAt: now,
      },
    });

    if (actor) {
      await auditService.record(tx, actor, {
        entityType: 'User',
        entityId: user.id,
        action: 'user.reactivated',
        fromState: 'deactivated',
        toState: 'active',
      });
    }

    return toPublicUser(updated);
  });
}
