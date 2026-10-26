// users services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module. See AGENTS.md "Non-negotiable rules".
//
// Phase 8 (issue #39): admin account lifecycle — invites and deactivation.
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
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

export async function createAdminInvite(input: CreateAdminInviteInput): Promise<CreatedAdminInvite> {
  const email = input.email.trim();
  if (!email) throw new HttpError(400, 'An email address is required.');

  const existing = await usersRepo.findUserByEmail(email);
  if (existing) {
    // Deliberately not "an account exists": that's already visible from the
    // signup endpoint, and an admin inviting a colleague needs the real
    // reason rather than a coin flip. Refusing here keeps the invite table
    // to addresses that can actually be redeemed.
    throw new HttpError(409, 'An account with this email already exists — deactivate or promote it instead of inviting it.');
  }

  const token = generateAdminInviteToken();
  const expiresAt = new Date(Date.now() + config.adminInvites.ttlHours * 60 * 60 * 1000);
  const invite = await usersRepo.replaceAdminInvite({
    email,
    tokenHash: hashAdminInviteToken(token),
    expiresAt,
    invitedByUserId: input.invitedByUserId,
  });

  return {
    id: invite.id,
    email: invite.email,
    expiresAt: invite.expiresAt,
    token,
    inviteUrl: `${config.adminInvites.acceptUrl}?token=${encodeURIComponent(token)}`,
  };
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
  if (!invite) throw new HttpError(400, 'Invalid admin invite token.');
  if (invite.consumedAt) throw new HttpError(400, 'This invite has already been used.');
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'This invite has expired. Ask an admin for a new one.');
  }
  if (invite.email.toLowerCase() !== input.email.trim().toLowerCase()) {
    throw new HttpError(403, 'This invite was issued for a different email address.');
  }

  const user = await usersRepo.consumeAdminInviteAndCreateAdmin({
    inviteId: invite.id,
    email: input.email.trim(),
    passwordHash: input.passwordHash,
    consumedAt: new Date(),
  });

  // Lost a race with a concurrent redemption of the same invite.
  if (!user) throw new HttpError(400, 'This invite has already been used.');

  return toPublicUser(user);
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
export async function deactivateUser(input: DeactivateInput): Promise<PublicUser> {
  const user = await usersRepo.findUserById(input.userId);
  if (!user) throw new HttpError(404, 'User not found.');
  if (user.deactivatedAt) return toPublicUser(user); // idempotent

  // The admin console is the only way back in, so the last active admin
  // must not be able to lock everyone out of it (explicit in issue #39).
  if (user.role === 'admin') {
    const activeAdmins = await usersRepo.countActiveUsersByRole('admin');
    if (activeAdmins <= 1) {
      throw new HttpError(409, 'Cannot deactivate the last active admin.');
    }
  }

  const updated = await usersRepo.setUserDeactivated(user.id, new Date());
  return toPublicUser(updated);
}

export async function reactivateUser(input: DeactivateInput): Promise<PublicUser> {
  const user = await usersRepo.findUserById(input.userId);
  if (!user) throw new HttpError(404, 'User not found.');
  if (!user.deactivatedAt) return toPublicUser(user); // idempotent

  const updated = await usersRepo.setUserReactivated(user.id, new Date());
  return toPublicUser(updated);
}
