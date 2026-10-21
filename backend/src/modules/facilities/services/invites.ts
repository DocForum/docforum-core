import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { prisma as db } from '../../../db/prisma-client';
import { createFacilityStaffAccount, findUserByEmail } from '../../auth/services';
import type { FacilityRole } from '@prisma/client';

export interface AcceptInviteResult {
  user: { id: string; email: string; role: string; emailVerifiedAt: Date | null; createdAt: Date; updatedAt: Date };
  isNew: boolean;
  facilityMember: { id: string; userId: string; facilityId: string; role: FacilityRole } | null;
}

export interface CreateInviteInput {
  facilityId: string;
  email: string;
  role?: FacilityRole;
}

export class InviteService {
  /** Create an invite for a staff member to join a facility. The raw token is
   * returned once to the caller (who passes it on out of band); only its
   * SHA-256 hash is stored. */
  async createInvite(input: CreateInviteInput): Promise<{ token: string; tokenHash: string }> {
    const { facilityId, email } = input;

    if (typeof email !== 'string' || email.trim() === '') {
      throw new HttpError(400, 'An email address is required.', 'INVALID_EMAIL');
    }
    // Exactly two fixed roles, and `staff` is the only invite-able one —
    // ownership transfer is explicitly out of scope for issue #75.
    const role: FacilityRole = input.role ?? 'staff';
    if (role !== 'staff') {
      throw new HttpError(400, 'Facility invites can only be sent for the "staff" role.', 'INVALID_INVITE_ROLE');
    }

    // Check if the email already belongs to a user who is in a facility
    const existingUser = await findUserByEmail(email);
    if (existingUser && await db.facilityMember.findUnique({ where: { userId: existingUser.id } })) {
      throw new HttpError(400, 'This email already belongs to a facility account.', 'USER_IN_FACILITY');
    }

    const token = generateToken();
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + config.facilityInvites.ttlMinutes * 60_000);

    // Check for existing unused invite with same email+facility
    const existing = await db.facilityInvite.findFirst({
      where: { facilityId, email, consumedAt: null },
    });
    if (existing) {
      // Re-issuing replaces the previous token, which the old hash no longer
      // matches — the invite stays single-use either way.
      await db.facilityInvite.update({
        where: { id: existing.id },
        data: { tokenHash, expiresAt, role },
      });
    } else {
      await db.facilityInvite.create({
        data: { facilityId, email, role, tokenHash, expiresAt },
      });
    }

    return { token, tokenHash };
  }

  /** Accept an invite token. Creates or retrieves the user and adds them to
   * the facility. No session is issued — the caller logs in separately. */
  async acceptInvite(token: string, password: string): Promise<AcceptInviteResult> {
    if (typeof token !== 'string' || token === '') {
      throw new HttpError(400, 'Invalid or expired invite token.', 'INVALID_INVITE_TOKEN');
    }
    const record = await db.facilityInvite.findUnique({
      where: { tokenHash: hash(token) },
    });

    if (!record) {
      throw new HttpError(400, 'Invalid or expired invite token.', 'INVALID_INVITE_TOKEN');
    }
    if (record.consumedAt) {
      throw new HttpError(400, 'This invite has already been used.', 'INVALID_INVITE_TOKEN');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'This invite has expired.', 'INVITE_TOKEN_EXPIRED');
    }

    // Check if a user with this email already exists
    const existingUser = await findUserByEmail(record.email);

    if (existingUser) {
      // User exists - check if they already belong to a facility
      const alreadyInFacility = await db.facilityMember.findUnique({ where: { userId: existingUser.id } });
      if (alreadyInFacility) {
        throw new HttpError(400, 'This user already belongs to a facility.', 'USER_IN_FACILITY');
      }

      const member = await this.consumeAndCreateMember(record.id, () =>
        db.facilityMember.create({
          data: { userId: existingUser.id, facilityId: record.facilityId, role: record.role },
        }),
      );

      return {
        user: {
          id: existingUser.id,
          email: existingUser.email,
          role: existingUser.role,
          emailVerifiedAt: existingUser.emailVerifiedAt,
          createdAt: existingUser.createdAt,
          updatedAt: existingUser.updatedAt,
        },
        isNew: false,
        facilityMember: toMemberPayload(member),
      };
    }

    // New user — create the facility account. No profile row: a facility
    // staff user's link to their facility is the FacilityMember, and
    // self-serve signup still refuses facility accounts (PRD OQ-2).
    if (!password || typeof password !== 'string') {
      throw new HttpError(400, 'Password required for new account creation.', 'MISSING_PASSWORD');
    }

    const newUser = await createFacilityStaffAccount({ email: record.email, password });

    const member = await this.consumeAndCreateMember(record.id, () =>
      db.facilityMember.create({
        data: { userId: newUser.id, facilityId: record.facilityId, role: record.role },
      }),
    );

    return {
      user: {
        id: newUser.id,
        email: newUser.email,
        role: newUser.role,
        emailVerifiedAt: newUser.emailVerifiedAt,
        createdAt: newUser.createdAt,
        updatedAt: newUser.updatedAt,
      },
      isNew: true,
      facilityMember: toMemberPayload(member),
    };
  }

  /** List pending invites for a facility. */
  async listInvites(facilityId: string) {
    return db.facilityInvite.findMany({
      where: { facilityId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Revoke a pending invite. */
  async revokeInvite(facilityId: string, tokenHash: string): Promise<void> {
    const invite = await db.facilityInvite.findFirst({
      where: { facilityId, tokenHash },
    });
    if (!invite) {
      throw new HttpError(404, 'Invite not found or already revoked.');
    }
    if (invite.consumedAt) {
      throw new HttpError(400, 'This invite has already been used.');
    }
    await db.facilityInvite.update({
      where: { id: invite.id },
      data: { consumedAt: new Date() },
    });
  }

  /** Single-use guarantee: consume the invite with a conditional update, so
   * two concurrent accepts of the same token cannot both win — the loser sees
   * count 0 and is refused before it creates a membership. */
  private async consumeAndCreateMember<T>(inviteId: string, create: () => Promise<T>): Promise<T> {
    const consumed = await db.facilityInvite.updateMany({
      where: { id: inviteId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new HttpError(400, 'This invite has already been used.', 'INVALID_INVITE_TOKEN');
    }
    return create();
  }
}

function toMemberPayload(member: { id: string; userId: string; facilityId: string; role: FacilityRole }) {
  return { id: member.id, userId: member.userId, facilityId: member.facilityId, role: member.role };
}

/** 32 random bytes, hex-encoded. Returned to the invitee exactly once. */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// Hash a token using SHA-256, return hex string for storage
function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
