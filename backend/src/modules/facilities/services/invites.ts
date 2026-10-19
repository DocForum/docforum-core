import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import { prisma as db } from '../../../db/prisma-client';
import { findUserByEmail } from '../../auth/services';
import { createSelfServeUser } from '../../auth/services';

export interface AcceptInviteResult {
  user: { id: string; email: string; role: string; emailVerifiedAt: Date | null; createdAt: Date; updatedAt: Date };
  isNew: boolean;
  facilityMember: any;
}

export interface CreateInviteInput {
  facilityId: string;
  email: string;
  role?: string;
}

export class InviteService {
  /** Create an invite for a staff member to join a facility. */
  async createInvite(input: CreateInviteInput): Promise<{ token: string; tokenHash: string }> {
    const { facilityId, email, role } = input;

    // Check if the email already belongs to a user who is in a facility
    const existingUser = await findUserByEmail(email);
    if (existingUser && await db.facilityMember.findUnique({ where: { userId: existingUser.id } })) {
      throw new HttpError(400, 'This email already belongs to a facility account.', 'USER_IN_FACILITY');
    }

    const token = this.generateToken();
    const tokenHash = hash(token);
    const expiresAt = new Date(Date.now() + config.invite.ttlMinutes * 60_000);

    // Check for existing unused invite with same email+facility
    const existing = await db.facilityInvite.findFirst({
      where: { facilityId, email, consumedAt: null },
    });
    if (existing) {
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

  /** Accept an invite token. Creates or retrieves the user and adds them to the facility. */
  async acceptInvite(token: string, password: string, fullName?: string): Promise<AcceptInviteResult> {
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

      // Add existing user to the facility as the invited role
      await db.facilityMember.create({
        data: { userId: existingUser.id, facilityId: record.facilityId, role: record.role },
      });

      // Build auth payload using the user's existing role
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
        facilityMember: null,
      };
    }

    // New user - create account with patient role
    if (!password) {
      throw new HttpError(400, 'Password required for new account creation.', 'MISSING_PASSWORD');
    }

    const username = record.email.split('@')[0];
    const newUser = await createSelfServeUser({
      email: record.email,
      password,
      role: record.role,
      fullName: fullName ?? username,
    });

    // Mark email as verified immediately so the user can log in right away
    await db.user.update({
      where: { id: newUser.id },
      data: { emailVerifiedAt: new Date() },
    });

    // Add new user to the facility as the invited role
    await db.facilityMember.create({
      data: { userId: newUser.id, facilityId: record.facilityId, role: record.role },
    });

    // Build auth payload
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
      facilityMember: null,
    };
  }

  /** List pending invites for a facility. */
  async listInvites(facilityId: string): Promise<any[]> {
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

  private generateToken(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return array.toString('base64');
  }
}

// Hash a token using SHA-256, return hex string for storage
function hash(token: string): string {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(token).digest('hex');
}